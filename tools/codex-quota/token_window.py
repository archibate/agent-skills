#!/usr/bin/env python3
"""Offline token accounting between observations in one quota window."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import sys
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path

import quota


def vector(value):
    if not isinstance(value, dict):
        return None
    fields = quota.TOKEN_FIELDS
    if any(
        not isinstance(value.get(k), int) or isinstance(value.get(k), bool)
        for k in fields
    ):
        return None
    result = {k: value[k] for k in fields}
    if any(v < 0 for v in result.values()):
        return None
    if (
        result["cached_input_tokens"] > result["input_tokens"]
        or result["reasoning_output_tokens"] > result["output_tokens"]
    ):
        return None
    if result["total_tokens"] != result["input_tokens"] + result["output_tokens"]:
        return None
    return result


def source_metadata(root):
    """Read only the first session header. Keep identifiers in memory only."""
    by_id = {}
    metadata = {}
    for path in sorted(root.rglob("*.jsonl")):
        if path.is_symlink():
            continue
        with path.open() as f:
            try:
                obj = json.loads(next(f))
            except (ValueError, StopIteration):
                continue
        p = obj.get("payload") or {}
        if obj.get("type") != "session_meta" or not isinstance(p, dict):
            continue
        source = hashlib.sha256(str(path.relative_to(root)).encode()).hexdigest()
        if isinstance(p.get("id"), str) and p["id"]:
            by_id[p["id"]] = source
        metadata[source] = {
            "created_at": quota.timestamp(p.get("timestamp") or obj.get("timestamp")),
            "parent": p.get("forked_from_id"),
        }
    for meta in metadata.values():
        meta["parent"] = by_id.get(meta["parent"])
    return metadata


def account_tokens(records, metadata):
    """Count positive deltas, verify fork baselines, and retain unresolved events."""
    histories = defaultdict(list)
    for record in records:
        usage = vector(record.get("total_token_usage"))
        if usage is not None and record.get("timestamp"):
            histories[record["source_sha256"]].append((record["timestamp"], usage))
    previous = {}
    counted_sources = set()
    ledger = []
    audit = Counter()
    for r in sorted(
        records, key=lambda r: (r["source_sha256"], r["source_byte_offset"])
    ):
        source = r["source_sha256"]
        meta = metadata.get(source, {})
        at = r.get("timestamp")
        if not at:
            audit["missing_timestamp"] += 1
            continue
        if meta.get("created_at") and quota.epoch(at) < quota.epoch(meta["created_at"]):
            audit["inherited_history_records_skipped"] += 1
            continue
        total = vector(r.get("total_token_usage"))
        last = vector(r.get("last_token_usage"))
        old = previous.get(source)
        if total is not None:
            previous[source] = total
        # A fork may emit a restored snapshot before any new request. Its `last`
        # object describes the parent's old request, even when total == last.
        if (
            source not in counted_sources
            and total is not None
            and meta.get("created_at")
            and any(
                u == total and quota.epoch(t) <= quota.epoch(meta["created_at"])
                for t, u in histories.get(meta.get("parent"), [])
            )
        ):
            audit["inherited_initial_snapshot_skipped"] += 1
            continue
        method = None
        delta = None
        if total is None:
            method = "invalid_usage"
        elif old is not None:
            candidate = {k: total[k] - old[k] for k in quota.TOKEN_FIELDS}
            if not any(candidate.values()):
                audit["unchanged_cumulative_snapshot"] += 1
                continue
            if any(v < 0 for v in candidate.values()):
                method = "counter_decreased"
            elif candidate != last:
                method = "delta_does_not_match_last_request"
            else:
                delta, method = candidate, "verified_counter_delta"
        elif last is None:
            method = "invalid_last_usage"
        elif total == last:
            delta, method = last, "fresh_counter"
        else:
            baseline = {k: total[k] - last[k] for k in quota.TOKEN_FIELDS}
            parent = meta.get("parent")
            matched = (
                any(
                    u == baseline and quota.epoch(t) <= quota.epoch(meta["created_at"])
                    for t, u in histories.get(parent, [])
                )
                if meta.get("created_at")
                else False
            )
            if matched:
                delta, method = last, "verified_fork_baseline"
            else:
                method = "unresolved_initial_counter"
        audit[method] += 1
        if delta is not None:
            counted_sources.add(source)
        ledger.append(
            {
                "timestamp": at,
                "source_sha256": source,
                "source_line": r["source_line"],
                "source_byte_offset": r["source_byte_offset"],
                "model": r.get("model"),
                "service_tier": r.get("service_tier"),
                "method": method,
                "usage": delta,
                "rate_limits": r.get("rate_limits"),
            }
        )
    return sorted(ledger, key=lambda r: quota.epoch(r["timestamp"])), dict(audit)


def canonical_requests(root, start, end):
    """Per-response records include compaction and delayed counter snapshots."""
    unique = {}
    before_start = set()
    for path in sorted(root.rglob("*.jsonl")):
        if path.is_symlink():
            continue
        source = hashlib.sha256(str(path.relative_to(root)).encode()).hexdigest()
        model = None
        with path.open("rb") as f:
            line_number = 0
            while True:
                offset = f.tell()
                line = f.readline()
                if not line:
                    break
                line_number += 1
                if not line.endswith(b"\n"):
                    continue
                if (
                    b'"turn_context"' not in line
                    and b'"token_usage_record"' not in line
                ):
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                p = r.get("payload") or {}
                if not isinstance(p, dict):
                    continue
                if r.get("type") == "turn_context":
                    model = quota.slug(p.get("model"))
                    continue
                at = quota.timestamp(r.get("timestamp"))
                if (
                    r.get("type") != "token_usage_record"
                    or not at
                    or quota.epoch(at) > quota.epoch(end)
                ):
                    continue
                response = p.get("response_id")
                if not isinstance(response, str) or not response:
                    if quota.epoch(at) <= quota.epoch(start):
                        continue
                    raise quota.SafeError("canonical_request_missing_response_id")
                digest = hashlib.sha256(response.encode()).hexdigest()
                # Exclude a replay even when its original is outside this window.
                # Files can be encountered in either chronological order.
                if quota.epoch(at) <= quota.epoch(start):
                    before_start.add(digest)
                    unique.pop(digest, None)
                    continue
                if digest in before_start:
                    continue
                used = vector(p.get("usage"))
                if used is None:
                    raise quota.SafeError("invalid_canonical_request_usage")
                if digest in unique:
                    if unique[digest]["usage"] != used:
                        raise quota.SafeError("conflicting_canonical_request_usage")
                    if quota.epoch(unique[digest]["timestamp"]) <= quota.epoch(at):
                        continue
                unique[digest] = {
                    "timestamp": at,
                    "source_sha256": source,
                    "source_line": line_number,
                    "source_byte_offset": offset,
                    "response_sha256": digest,
                    "model": model,
                    "service_tier": None,
                    "usage": used,
                    "method": "canonical_response",
                    "rate_limits": None,
                }
    return sorted(unique.values(), key=lambda r: quota.epoch(r["timestamp"]))


def reconcile_requests(counters, canonical):
    """Prefer unique responses; counters supplement unmatched observed requests."""
    ledger = [dict(r) for r in canonical]
    available = set(range(len(ledger)))
    unmatched = []
    for counter in counters:
        candidates = [
            i
            for i in available
            if ledger[i]["source_sha256"] == counter["source_sha256"]
            and ledger[i]["usage"] == counter["usage"]
        ]
        if candidates:
            index = min(
                candidates,
                key=lambda i: abs(
                    quota.epoch(ledger[i]["timestamp"])
                    - quota.epoch(counter["timestamp"])
                ),
            )
            available.remove(index)
            ledger[index]["counter_timestamp"] = counter["timestamp"]
            ledger[index]["rate_limits"] = counter.get("rate_limits")
        else:
            unmatched.append(
                {**counter, "method": "counter_fallback." + counter["method"]}
            )
    return sorted(ledger + unmatched, key=lambda r: quota.epoch(r["timestamp"])), {
        "canonical_requests": len(canonical),
        "matched_counter_requests": len(canonical) - len(available),
        "canonical_without_counter_snapshot": len(available),
        "counter_fallback_requests": len(unmatched),
    }


def fit_in_units(points, rounding, unit):
    result = quota.fit_constraints(points, rounding)
    result["unit"] = unit
    for side in ("lower", "upper"):
        if side + "_credits" in result:
            result[side] = result.pop(side + "_credits")
    return result


def estimate(
    records,
    metadata,
    sample,
    minutes=10080,
    rounding="unknown",
    markers=(),
    canonical_loader=None,
):
    before = sample.get("quota_before", {}).get("data") or {}
    after = sample.get("quota_after", {}).get("data") or {}
    _, left = quota.pick_window(before, minutes)
    _, right = quota.pick_window(after, minutes)
    if not left or not right:
        raise quota.SafeError("window_not_exposed")
    if any(quota.number(w.get("resets_at")) is None for w in (left, right)):
        raise quota.SafeError("reset_time_unavailable")
    if any(quota.number(w.get("used_percent")) is None for w in (left, right)):
        raise quota.SafeError("endpoint_percentage_unavailable")
    if (
        before.get("plan_type") != after.get("plan_type")
        or left["resets_at"] != right["resets_at"]
    ):
        raise quota.SafeError("end_sample_crosses_plan_or_reset")
    if right["used_percent"] < left["used_percent"] or right["used_percent"] >= 100:
        raise quota.SafeError("end_sample_decreased_or_saturated")
    # Stop at the first quota GET: later work cannot be charged to its percentage.
    cutoff = sample["quota_before"]["finished_at"]
    request_start = sample["quota_before"]["started_at"]
    reset = right["resets_at"]
    plan = after.get("plan_type")
    if quota.epoch(cutoff) >= reset:
        raise quota.SafeError("end_sample_after_reset")
    snapshots = []
    for r in records:
        limits = r.get("rate_limits") or {}
        _, w = quota.pick_window(limits, minutes)
        if (
            w
            and quota.number(w.get("used_percent")) is not None
            and w.get("resets_at") == reset
            and limits.get("plan_type") == plan
            and r.get("timestamp")
            and quota.epoch(r["timestamp"]) <= quota.epoch(request_start)
        ):
            snapshots.append(r)
    snapshots.sort(key=lambda r: quota.epoch(r["timestamp"]))
    if not snapshots:
        raise quota.SafeError("no_same_window_baseline")
    baseline = snapshots[0]
    start = baseline["timestamp"]
    _, start_window = quota.pick_window(baseline["rate_limits"], minutes)
    if any(
        quota.epoch(start) < quota.epoch(m["at"]) <= quota.epoch(cutoff)
        for m in markers
    ):
        raise quota.SafeError("interval_crosses_known_regime_change")
    ledger, audit = account_tokens(records, metadata)
    selected = [
        r
        for r in ledger
        if quota.epoch(start) < quota.epoch(r["timestamp"]) <= quota.epoch(cutoff)
    ]
    invalid = [r for r in selected if r["usage"] is None]
    for r in selected:
        q = r.get("rate_limits") or {}
        _, w = quota.pick_window(q, minutes)
        if not w or w.get("resets_at") != reset or q.get("plan_type") != plan:
            invalid.append(
                {
                    "timestamp": r["timestamp"],
                    "method": "different_or_missing_quota_epoch",
                }
            )
    reconciliation = None
    if canonical_loader is not None:
        canonical = canonical_loader(start, cutoff)
        by_source = defaultdict(list)
        for r in records:
            if r.get("timestamp"):
                by_source[r["source_sha256"]].append(r)
        for request in canonical:
            candidates = by_source.get(request["source_sha256"], [])
            if not candidates:
                invalid.append(
                    {
                        "timestamp": request["timestamp"],
                        "method": "canonical_quota_epoch_unavailable",
                    }
                )
                continue
            closest = min(
                candidates,
                key=lambda r: abs(
                    quota.epoch(r["timestamp"]) - quota.epoch(request["timestamp"])
                ),
            )
            q = closest.get("rate_limits") or {}
            _, w = quota.pick_window(q, minutes)
            if not w or w.get("resets_at") != reset or q.get("plan_type") != plan:
                invalid.append(
                    {
                        "timestamp": request["timestamp"],
                        "method": "canonical_different_quota_epoch",
                    }
                )
        selected, reconciliation = reconcile_requests(selected, canonical)
        if canonical and reconciliation["counter_fallback_requests"]:
            invalid.append(
                {
                    "timestamp": cutoff,
                    "method": "unmatched_counters_may_duplicate_canonical_requests",
                }
            )
            # Preserve candidates in the ledger, but block every extrapolation.
    totals = Counter()
    models = defaultdict(Counter)
    for r in selected:
        if r["usage"]:
            totals.update(r["usage"])
            models[str(r["model"])].update(r["usage"])
    for counter in [totals, *models.values()]:
        counter["uncached_input_tokens"] = (
            counter["input_tokens"] - counter["cached_input_tokens"]
        )
    seen_percent = start_window["used_percent"]
    seen_sources = {baseline["source_sha256"]: seen_percent}
    ordering_warnings = []
    for r in snapshots[1:]:
        _, w = quota.pick_window(r["rate_limits"], minutes)
        if w["used_percent"] < seen_percent:
            ordering_warnings.append(
                {
                    "timestamp": r["timestamp"],
                    "method": "cross_source_percentage_reversal",
                    "percentage_points": seen_percent - w["used_percent"],
                }
            )
        source = r["source_sha256"]
        if w["used_percent"] < seen_sources.get(source, w["used_percent"]):
            invalid.append(
                {"timestamp": r["timestamp"], "method": "quota_decreased_within_source"}
            )
        seen_sources[source] = w["used_percent"]
        seen_percent = w["used_percent"]
    if left["used_percent"] < seen_percent:
        invalid.append({"timestamp": cutoff, "method": "quota_decreased_at_endpoint"})
    report = {
        "status": "conditional_local_token_proxy"
        if not invalid
        else "accounting_incomplete",
        "sample_id": sample["id"],
        "start_exclusive": start,
        "end_inclusive": cutoff,
        "window_minutes": minutes,
        "resets_at": reset,
        "plan_type": plan,
        "start_used_percent": start_window["used_percent"],
        "end_used_percent": left["used_percent"],
        "request_timing_uncertainty_events": sum(
            quota.epoch(r["timestamp"]) > quota.epoch(request_start) for r in selected
        ),
        "account_attribution": "local_logs_unverified_against_account",
        "request_records": len(selected),
        "accounting_methods": dict(Counter(r["method"] for r in selected)),
        "reconciliation": reconciliation,
        "totals": dict(totals),
        "models": {m: dict(c) for m, c in models.items()},
        "unresolved_events": invalid,
        "quota_ordering_warnings": ordering_warnings,
        "scan_accounting_audit": audit,
        "assumptions": [
            "Local requests belong to the sampled account and their quota reads are current.",
            "The local workload mix represents usage over the quota interval.",
            "Missing web, mobile, other-host or other-feature usage biases a local-token proxy.",
            "Token-rate credit equivalents need not equal included-quota weights.",
            "Cross-source percentage reversals are stale observations rather than hidden resets.",
        ],
    }
    daily = sample.get("daily", {}).get("data") or {}
    report["daily_units"] = daily.get("units")
    report["other_surfaces_observed"] = sorted(
        {
            surface
            for day in daily.get("data", [])
            if start[:10] <= day["date"] <= cutoff[:10]
            for surface, amount in (
                day.get("product_surface_usage_values") or {}
            ).items()
            if surface not in {"cli", "vscode"} and amount and amount > 0
        }
    )
    if invalid:
        return report, selected
    zero = {
        "credits": 0,
        "percent_low": start_window["used_percent"],
        "percent_high": start_window["used_percent"],
    }
    end = {
        "credits": totals["total_tokens"],
        "percent_low": left["used_percent"],
        "percent_high": left["used_percent"],
    }
    report["endpoint_mix_extrapolation"] = fit_in_units(
        [zero, end], rounding, "input_plus_output_tokens_per_100_percent"
    )
    if left["used_percent"] > start_window["used_percent"]:
        report["nominal_mix_extrapolation"] = (
            Decimal(totals["total_tokens"])
            * 100
            / Decimal(str(left["used_percent"] - start_window["used_percent"]))
        )
    # Test, rather than assume, whether one raw-token denominator fits all points.
    running = 0
    points = [zero]
    for r in selected:
        running += r["usage"]["total_tokens"]
        _, w = quota.pick_window(r.get("rate_limits") or {}, minutes)
        if w and quota.number(w.get("used_percent")) is not None:
            points.append(
                {
                    "credits": running,
                    "percent_low": w["used_percent"],
                    "percent_high": w["used_percent"],
                }
            )
    points.append(end)
    report["constant_raw_token_denominator_test"] = fit_in_units(
        points, rounding, "input_plus_output_tokens_per_100_percent"
    )
    report["constant_raw_token_denominator_test"]["ordering_sensitive"] = bool(
        ordering_warnings
    )
    monotone = []
    high_water = Decimal(-1)
    for point in points:
        if point["percent_low"] >= high_water:
            monotone.append(point)
            high_water = point["percent_low"]
    report["monotone_raw_token_denominator_test"] = fit_in_units(
        monotone, rounding, "input_plus_output_tokens_per_100_percent"
    )
    report["monotone_raw_token_denominator_test"]["points_removed"] = len(points) - len(
        monotone
    )
    astra = models.get("gpt-6-astra")
    if astra:
        equivalent = (
            Decimal(250) * astra["uncached_input_tokens"]
            + Decimal(25) * astra["cached_input_tokens"]
            + Decimal(1250) * astra["output_tokens"]
        ) / 1000000
        report["astra_only_credit_equivalent"] = {
            "standard_scenario": equivalent,
            "fast_scenario": equivalent * Decimal("2.5"),
            "actual_service_tier": "unknown",
            "unpriced_models": sorted(set(models) - {"gpt-6-astra"}),
            "rate_source": "https://learn.chatgpt.com/docs/pricing",
            "rate_checked_at": "2026-09-24",
            "included_quota_weighting_verified": False,
            "cache_write_tokens_observed": astra["cache_write_input_tokens"],
            "cache_write_policy": "no_separate_credit_surcharge; noncached_input_formula_not_separately_calibrated",
        }
    report["absolute_credit_denominator"] = None
    report["pro5x_over_4989_7"] = None
    return report, selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir", type=Path, default=Path(__file__).resolve().parent / "data"
    )
    parser.add_argument(
        "--sessions", type=Path, default=Path.home() / ".codex/sessions"
    )
    parser.add_argument(
        "--window-minutes", type=int, choices=(300, 10080), default=10080
    )
    parser.add_argument(
        "--rounding", choices=("unknown", "nearest", "floor", "ceil"), default="unknown"
    )
    args = parser.parse_args()
    try:
        quota.private_dir(args.data_dir)
        with os.fdopen(
            quota.private_open(args.data_dir / ".lock", os.O_CREAT | os.O_RDWR), "a"
        ) as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            records = quota.read_records(args.data_dir / "rollouts.jsonl")
            samples = quota.read_records(args.data_dir / "samples.jsonl")
            if not samples:
                raise quota.SafeError("no_account_sample")
            sample = max(samples, key=lambda r: quota.epoch(r["started_at"]))
            markers = quota.read_records(args.data_dir / "regimes.jsonl")
            for observed in samples:
                for period in (
                    observed.get("history", {}).get("data", {}).get("periods", [])
                ):
                    for key in ("starts_at", "ends_at"):
                        if quota.timestamp(period.get(key)):
                            markers.append({"at": period[key]})
            report, ledger = estimate(
                records,
                source_metadata(args.sessions),
                sample,
                args.window_minutes,
                args.rounding,
                markers,
                lambda start, end: canonical_requests(args.sessions, start, end),
            )
            quota.atomic_text(
                args.data_dir / "token_window.json", quota.json_text(report) + "\n"
            )
            quota.atomic_text(
                args.data_dir / "token_window_events.jsonl",
                "".join(quota.json_text(r) + "\n" for r in ledger),
            )
        print(quota.json_text(report))
        return 0
    except quota.SafeError as error:
        print(quota.json_text({"error": str(error)}), file=sys.stderr)
        return 1
    except Exception:  # noqa: BLE001 - suppress source data and identifiers in errors
        print(
            '{"error":"local_token_analysis_failed_details_suppressed"}',
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
