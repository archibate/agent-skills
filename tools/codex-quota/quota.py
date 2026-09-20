#!/usr/bin/env python3
"""Local, read-only Codex quota recorder. Python standard library only."""

from __future__ import annotations

import argparse
import csv
import fcntl
import hashlib
import hmac
import io
import json
import math
import os
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal, localcontext
from pathlib import Path

VERSION = 1
BASE = "https://chatgpt.com/backend-api/wham/usage"
ENDPOINTS = {
    "quota": "",
    "daily": "/daily-token-usage-breakdown",
    "history": "/plan_limit_history?days=30",
}
TOKEN_FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)
WINDOW_FIELDS = ("used_percent", "window_minutes", "resets_at")
SURFACES = {
    "cli",
    "vscode",
    "web",
    "work_web",
    "mobile",
    "work_mobile",
    "slack",
    "linear",
    "jetbrains",
    "sdk",
    "exec",
    "github",
    "desktop_app",
    "work_desktop",
    "github_code_review",
    "agent_identity",
    "unknown",
}
NUMERIC_MAPS = {
    "product_surface_usage_values",
    "total_usage_credits",
    "credit_usage_credits",
    "uncached_text_input_tokens_by_surface",
    "cached_text_input_tokens_by_surface",
    "text_output_tokens_by_surface",
    "text_total_tokens_by_surface",
    "total_tokens_by_surface",
}
MODEL_NUMBERS = {
    "credits",
    "on_demand_credits",
    "input_tokens",
    "cached_input_tokens",
    "uncached_input_tokens",
    "output_tokens",
    "total_tokens",
}
PRIVATE_FIELDS = {
    "access_token",
    "refresh_token",
    "id_token",
    "account_id",
    "user_id",
    "email",
    "cookies",
    "cookie",
    "authorization",
    "api_key",
    "openai_api_key",
    "id",
    "thread_id",
    "session_id",
    "organization_id",
    "workspace_id",
}


class SafeError(Exception):
    """Messages are static and never include server text or credentials."""


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            return None
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def epoch(value):
    value = timestamp(value)
    return (
        datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        if value
        else None
    )


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    return value if math.isfinite(value) else None


def slug(value):
    # Only schema-defined categorical fields pass here, never arbitrary text.
    return (
        value
        if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_.:/-]{1,100}", value)
        else None
    )


def json_text(value):
    # Preserve every decimal digit supplied by the analytics endpoint.
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise SafeError("nonfinite_number")
        return str(value)
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(json.dumps(k) + ":" + json_text(v) for k, v in value.items())
            + "}"
        )
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(json_text(v) for v in value) + "]"
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))


def decode(value):
    return json.loads(value, parse_float=Decimal)


def private_dir(path):
    if path.is_symlink():
        raise SafeError("symlink_data_directory")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def private_open(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise SafeError("nonregular_data_file")
    os.fchmod(fd, 0o600)
    return fd


def append(path, record):
    with os.fdopen(
        private_open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND), "ab"
    ) as f:
        f.write((json_text(record) + "\n").encode())
        f.flush()
        os.fsync(f.fileno())


def atomic_text(path, content):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".quota-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_records(path):
    if not path.exists():
        return []
    with path.open() as f:
        try:
            return [decode(line) for line in f if line.strip()]
        except (ValueError, TypeError):
            raise SafeError("invalid_record_file") from None


def usage_projection(value):
    if not isinstance(value, dict):
        return None
    return {k: number(value.get(k)) for k in TOKEN_FIELDS}


def window_projection(value, api=False):
    if not isinstance(value, dict):
        return None
    if api:
        seconds = number(value.get("limit_window_seconds"))
        return {
            "used_percent": number(value.get("used_percent")),
            "window_minutes": Decimal(seconds) / 60 if seconds is not None else None,
            "resets_at": number(value.get("reset_at")),
            "limit_window_seconds": seconds,
            "reset_after_seconds": number(value.get("reset_after_seconds")),
        }
    return {k: number(value.get(k)) for k in WINDOW_FIELDS}


def limits_projection(value, api=False):
    if not isinstance(value, dict):
        return None
    limits = value.get("rate_limit") if api else value
    limits = limits if isinstance(limits, dict) else {}
    result = {
        "plan_type": slug(value.get("plan_type")),
        "limit_id": "codex" if api else slug(value.get("limit_id")),
        "primary": window_projection(
            limits.get("primary_window" if api else "primary"), api
        ),
        "secondary": window_projection(
            limits.get("secondary_window" if api else "secondary"), api
        ),
    }
    credits = value.get("credits")
    if isinstance(credits, dict):
        result["credits"] = {
            k: credits.get(k) if isinstance(credits.get(k), bool) else None
            for k in ("has_credits", "unlimited")
        }
        balance = credits.get("balance")
        if isinstance(balance, str) and re.fullmatch(r"-?\d+(\.\d+)?", balance):
            result["credits"]["balance"] = balance
    return result


def daily_projection(value):
    """Whitelisted numerical response, not an unsafe raw account response dump."""
    if not isinstance(value, dict) or not isinstance(value.get("data"), list):
        raise SafeError("unexpected_daily_schema")
    result = {
        "units": slug(value.get("units")),
        "group_by": slug(value.get("group_by")),
        "data_freshness_ts": timestamp(value.get("data_freshness_ts")),
        "data": [],
    }
    unknown_surfaces = set()

    def surface_map(mapping):
        if not isinstance(mapping, dict):
            return None
        unknown_surfaces.update(set(mapping) - SURFACES)
        # Unknown map keys could be identifiers: retain their numbers, never their text.
        return {k: number(v) for k, v in mapping.items() if k in SURFACES}

    for row in value["data"]:
        if not isinstance(row, dict):
            raise SafeError("unexpected_daily_row")
        date = row.get("date")
        if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise SafeError("unexpected_daily_date")
        out = {"date": date}
        out["product_surface_usage_values"] = surface_map(
            row.get("product_surface_usage_values")
        )
        if isinstance(row.get("premium_usage_values"), dict):
            out["premium_usage_values"] = {
                k: surface_map(v)
                for k, v in row["premium_usage_values"].items()
                if k in NUMERIC_MAPS
            }
        if isinstance(row.get("models"), list):
            out["models"] = [
                {
                    "model": slug(m.get("model")),
                    "speed": slug(m.get("speed")),
                    **{k: number(v) for k, v in m.items() if k in MODEL_NUMBERS},
                }
                for m in row["models"]
                if isinstance(m, dict)
            ]

        # Preserve all other raw numeric leaves by structural position. Never retain
        # unrecognized keys/strings (which may contain account or thread identifiers).
        def numeric_leaves(node, position=()):
            found = []
            if isinstance(node, dict):
                for index, (key, item) in enumerate(node.items()):
                    if key.lower() not in PRIVATE_FIELDS:
                        found.extend(numeric_leaves(item, position + (index,)))
            elif isinstance(node, list):
                for index, item in enumerate(node):
                    found.extend(numeric_leaves(item, position + (index,)))
            elif number(node) is not None:
                found.append({"position": list(position), "value": node})
            return found

        out["raw_numeric_leaves"] = [
            leaf
            for index, (key, item) in enumerate(row.items())
            if key
            in {
                "product_surface_usage_values",
                "premium_usage_values",
                "models",
                "attribution",
                "groups",
            }
            for leaf in numeric_leaves(item, (index,))
        ]
        result["data"].append(out)
    result["unknown_surface_count"] = len(unknown_surfaces)
    return result


def history_projection(value):
    if not isinstance(value, dict) or not isinstance(value.get("periods"), list):
        raise SafeError("unexpected_history_schema")
    return {
        "data_as_of": timestamp(value.get("data_as_of")),
        "coverage_start": timestamp(value.get("coverage_start")),
        "coverage_complete": value.get("coverage_complete") is True,
        "approximate": value.get("approximate", True) is not False,
        "boundary_tolerance_seconds": number(value.get("boundary_tolerance_seconds")),
        "periods": [
            {
                "window_minutes": number(p.get("window_minutes")),
                "plan_type": slug(p.get("plan_type")),
                "starts_at": timestamp(p.get("starts_at")),
                "ends_at": timestamp(p.get("ends_at")),
                "accounting_complete": p.get("accounting_complete") is True,
                "used_basis_points": number(p.get("used_basis_points")),
            }
            for p in value["periods"]
            if isinstance(p, dict)
        ],
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class AccountClient:
    def __init__(self, auth_path, data_dir):
        try:
            auth = json.loads(auth_path.read_text())
            tokens = auth["tokens"]
            access, account = tokens["access_token"], tokens["account_id"]
            if not all(
                isinstance(x, str) and x and "\n" not in x and "\r" not in x
                for x in (access, account)
            ):
                raise ValueError()
        except Exception:  # noqa: BLE001 - credential-bearing errors must not escape
            raise SafeError("auth_unavailable_no_refresh_attempted") from None
        salt_path = data_dir / ".account-salt"
        if not salt_path.exists():
            with os.fdopen(
                private_open(salt_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY), "wb"
            ) as f:
                f.write(os.urandom(32))
        with os.fdopen(private_open(salt_path, os.O_RDONLY), "rb") as f:
            salt = f.read()
        if len(salt) != 32:
            raise SafeError("invalid_account_salt")
        self.account_tag = hmac.new(salt, account.encode(), hashlib.sha256).hexdigest()
        self.headers = {
            "Authorization": "Bearer " + access,
            "ChatGPT-Account-Id": account,
            "Accept": "application/json",
            "User-Agent": "codex-quota-local/1",
        }
        self.secrets = {v for k, v in tokens.items() if isinstance(v, str) and v}
        self.opener = urllib.request.build_opener(NoRedirect())

    def exclude_secrets(self, value):
        if isinstance(value, str):
            return None if any(secret in value for secret in self.secrets) else value
        if isinstance(value, dict):
            return {k: self.exclude_secrets(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.exclude_secrets(v) for v in value]
        return value

    def get(self, endpoint):
        if endpoint not in ENDPOINTS:
            raise SafeError("endpoint_not_allowed")
        result = {"endpoint": endpoint, "started_at": now()}
        try:
            request = urllib.request.Request(
                BASE + ENDPOINTS[endpoint], headers=self.headers, method="GET"
            )
            with self.opener.open(request, timeout=30) as response:
                result["http_status"] = response.status
                body = response.read(8_000_001)
            if len(body) > 8_000_000:
                raise SafeError("response_too_large")
            raw = decode(body)
            project = {
                "quota": lambda x: limits_projection(x, True),
                "daily": daily_projection,
                "history": history_projection,
            }[endpoint]
            result["data"] = self.exclude_secrets(project(raw))
            if result["data"] is None:
                raise SafeError("unexpected_response_schema")
        except urllib.error.HTTPError as error:
            result["http_status"] = error.code
            result["error"] = (
                "http_error"  # No URL, body, headers, cookies or exception text.
            )
            error.close()
        except SafeError as error:
            result["error"] = str(error)
        except Exception:  # noqa: BLE001 - HTTP/JSON errors may contain response secrets
            result["error"] = "network_or_json_error"
        result["finished_at"] = now()
        return result


def sample(args):
    client = AccountClient(args.auth, args.data_dir)
    record = {
        "schema_version": VERSION,
        "kind": "sample",
        "id": uuid.uuid4().hex,
        "label": args.label,
        "account_tag": client.account_tag,
        "started_at": now(),
    }
    # Bracket daily analytics with quota reads: work may continue while recording.
    record["quota_before"] = client.get("quota")
    record["daily"] = client.get("daily")
    record["quota_after"] = client.get("quota")
    if args.history:
        record["history"] = client.get("history")
    record["finished_at"] = now()
    append(args.data_dir / "samples.jsonl", record)
    print(
        json_text(
            {
                "sample_id": record["id"],
                "label": record["label"],
                "quota": record["quota_after"],
                "daily_status": {
                    k: v for k, v in record["daily"].items() if k != "data"
                },
                "daily_units": record["daily"].get("data", {}).get("units"),
                "daily_days": len(record["daily"].get("data", {}).get("data", [])),
                "history_status": {
                    k: v for k, v in record.get("history", {}).items() if k != "data"
                },
            }
        )
    )
    return 0 if all("data" in record[k] for k in ("quota_before", "quota_after")) else 1


def rollout_records(root, stats):
    for path in sorted(root.rglob("*.jsonl")):
        if path.is_symlink():
            stats["symlinks_skipped"] += 1
            continue
        stats["files"] += 1
        # A path digest + byte offset gives provenance without copying path strings.
        source = hashlib.sha256(str(path.relative_to(root)).encode()).hexdigest()
        model = tier = None
        with path.open("rb") as f:
            size = os.fstat(f.fileno()).st_size
            line_number = 0
            while f.tell() < size:
                offset = f.tell()
                line = f.readline(size - offset)
                line_number += 1
                if not line.endswith(b"\n"):
                    stats["partial_lines_skipped"] += 1
                    break
                try:
                    obj = json.loads(line)
                    p = obj.get("payload")
                    if not isinstance(p, dict):
                        continue
                    if obj.get("type") == "turn_context":
                        model = slug(p.get("model"))
                        tier = slug(p.get("service_tier"))
                    if obj.get("type") == "session_meta":
                        model = slug(p.get("model")) or model
                    if obj.get("type") != "event_msg" or p.get("type") != "token_count":
                        continue
                    info = p.get("info") or {}
                    if not isinstance(info, dict):
                        info = {}
                    stats["events"] += 1
                    yield {
                        "schema_version": VERSION,
                        "kind": "token_count",
                        "source_sha256": source,
                        "source_line": line_number,
                        "source_byte_offset": offset,
                        "timestamp": timestamp(obj.get("timestamp")),
                        "model": slug(p.get("model"))
                        or slug(info.get("model"))
                        or model,
                        "service_tier": tier,
                        "total_token_usage": usage_projection(
                            info.get("total_token_usage")
                        ),
                        "last_token_usage": usage_projection(
                            info.get("last_token_usage")
                        ),
                        "rate_limits": limits_projection(p.get("rate_limits")),
                    }
                except (ValueError, TypeError, AttributeError):
                    stats["malformed_lines_skipped"] += 1


def flatten(record):
    result = {}
    for k, v in record.items():
        if isinstance(v, dict):
            result.update({k + "." + name: val for name, val in flatten(v).items()})
        else:
            result[k] = v
    return result


def boundary_reasons(previous, current):
    if previous is None:
        return ["first_observation"]
    reasons = []
    if current is None:
        return ["quota_state_unavailable"]
    if previous.get("plan_type") != current.get("plan_type"):
        reasons.append("plan_type_changed")
    if previous.get("limit_id") != current.get("limit_id"):
        reasons.append("limit_id_changed")
    for slot in ("primary", "secondary"):
        left, right = previous.get(slot) or {}, current.get(slot) or {}
        if left.get("window_minutes") != right.get("window_minutes"):
            reasons.append(slot + ".window_changed")
        if left.get("resets_at") != right.get("resets_at"):
            reasons.append(slot + ".reset_at_changed")
        a, b = left.get("used_percent"), right.get("used_percent")
        if a is not None and b is not None and b < a:
            reasons.append(slot + ".usage_decreased_possible_reset_or_stale_read")
    return reasons


def scan(args):
    if not args.sessions.is_dir():
        raise SafeError("sessions_directory_missing")
    stats = dict.fromkeys(
        (
            "files",
            "events",
            "symlinks_skipped",
            "partial_lines_skipped",
            "malformed_lines_skipped",
        ),
        0,
    )
    records = list(rollout_records(args.sessions, stats))
    previous_source = previous_limits = None
    source_epoch = 0
    boundaries = []
    for record in records:
        if record["source_sha256"] != previous_source:
            previous_limits = None
            source_epoch = 0
        reasons = boundary_reasons(previous_limits, record["rate_limits"])
        if reasons:
            source_epoch += 1
            boundaries.append(
                {
                    "source_sha256": record["source_sha256"],
                    "source_line": record["source_line"],
                    "timestamp": record["timestamp"],
                    "source_epoch": source_epoch,
                    "reasons": reasons,
                }
            )
        record["source_epoch"] = source_epoch
        previous_source, previous_limits = (
            record["source_sha256"],
            record["rate_limits"],
        )
    atomic_text(
        args.data_dir / "rollouts.jsonl", "".join(json_text(r) + "\n" for r in records)
    )
    atomic_text(
        args.data_dir / "rollout_boundaries.jsonl",
        "".join(json_text(r) + "\n" for r in boundaries),
    )
    flattened = [flatten(r) for r in records]
    columns = sorted({k for row in flattened for k in row})
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns)
    writer.writeheader()
    writer.writerows(flattened)
    atomic_text(args.data_dir / "rollouts.csv", buffer.getvalue())
    result = {
        "recorded_at": now(),
        **stats,
        "account_attribution": "unknown_for_historical_rollouts",
        "counters_are_not_additive": True,
    }
    atomic_text(args.data_dir / "scan.json", json_text(result) + "\n")
    print(json_text(result))
    return 0


def pick_window(limits, minutes):
    matches = [
        (slot, limits.get(slot))
        for slot in ("primary", "secondary")
        if isinstance(limits.get(slot), dict)
        and limits[slot].get("window_minutes") == minutes
    ]
    return matches[0] if len(matches) == 1 else (None, None)


def percent_bounds(value, rounding):
    p = Decimal(str(value))
    if not 0 <= p <= 100:
        raise SafeError("invalid_used_percent")
    offsets = {
        "unknown": (-1, 1),
        "nearest": (Decimal("-0.5"), Decimal("0.5")),
        "floor": (0, 1),
        "ceil": (-1, 0),
    }
    low, high = offsets[rounding]
    return max(Decimal(0), p + low), min(Decimal(100), p + high)


def fit_constraints(observations, rounding="unknown"):
    """All pairwise differences eliminate the unknown initial credit offset.

    Each observation contains a measured cumulative credit value and a percentage
    interval. Closed outer bounds conservatively include rounding tie endpoints.
    """
    lower = Decimal(0)
    upper = None
    informative = 0
    for i, left in enumerate(observations):
        for right in observations[i + 1 :]:
            delta = Decimal(str(right["credits"])) - Decimal(str(left["credits"]))
            lo1, hi1 = (
                percent_bounds(left["percent_low"], rounding)[0],
                percent_bounds(left["percent_high"], rounding)[1],
            )
            lo2, hi2 = (
                percent_bounds(right["percent_low"], rounding)[0],
                percent_bounds(right["percent_high"], rounding)[1],
            )
            dlo, dhi = (lo2 - hi1) / 100, (hi2 - lo1) / 100
            if (
                delta < 0
                or dhi < 0
                or (delta > 0 and dhi <= 0)
                or (delta == 0 and dlo > 0)
            ):
                return {
                    "status": "inconsistent",
                    "reason": "credit_and_percentage_constraints_conflict",
                }
            if delta == 0:
                continue
            informative += 1
            with localcontext() as ctx:
                ctx.prec = 50
                ctx.rounding = ROUND_FLOOR
                lower = max(lower, delta / dhi)
            if dlo > 0:
                with localcontext() as ctx:
                    ctx.prec = 50
                    ctx.rounding = ROUND_CEILING
                    bound = delta / dlo
                upper = min(upper, bound) if upper is not None else bound
    if upper is not None and lower > upper:
        return {"status": "inconsistent", "reason": "empty_intersection"}
    return {
        "status": "bounded"
        if upper is not None
        else "lower_bound_only"
        if informative
        else "insufficient_data",
        "lower_credits": lower if informative else None,
        "upper_credits": upper,
        "informative_pairs": informative,
        "rounding": rounding,
    }


def daily_credit_values(daily):
    if daily.get("units") != "credits":
        raise SafeError("daily_units_not_credits")
    if daily.get("group_by") not in (None, "day") or daily.get(
        "unknown_surface_count", 0
    ):
        raise SafeError("daily_schema_not_supported_for_inference")
    result = {}
    for row in daily.get("data", []):
        values = row.get("product_surface_usage_values")
        if (
            not isinstance(values, dict)
            or not values
            or any(number(v) is None or v < 0 for v in values.values())
        ):
            raise SafeError("daily_credit_values_unavailable")
        if row["date"] in result:
            raise SafeError("duplicate_daily_date")
        result[row["date"]] = sum(
            (Decimal(str(v)) for v in values.values()), Decimal(0)
        )
    if not result:
        raise SafeError("empty_daily_analytics")
    return result


def observation(sample_record, minutes, rounding, markers):
    left = sample_record.get("quota_before", {}).get("data") or {}
    right = sample_record.get("quota_after", {}).get("data") or {}
    a_slot, a = pick_window(left, minutes)
    b_slot, b = pick_window(right, minutes)
    if not a or not b:
        raise SafeError("window_not_exposed")
    shape = lambda r: tuple(
        (slot, (r.get(slot) or {}).get("window_minutes"))
        for slot in ("primary", "secondary")
    )
    if (
        left.get("plan_type") != right.get("plan_type")
        or shape(left) != shape(right)
        or a_slot != b_slot
    ):
        raise SafeError("plan_or_window_changed_during_sample")
    if (
        not left.get("plan_type")
        or a.get("resets_at") is None
        or a.get("resets_at") != b.get("resets_at")
    ):
        raise SafeError("reset_changed_or_unknown_during_sample")
    if any(number(w.get("used_percent")) is None for w in (a, b)):
        raise SafeError("used_percent_unavailable")
    if b["used_percent"] < a["used_percent"]:
        raise SafeError("usage_decreased_during_sample")
    if b["used_percent"] >= 100:
        raise SafeError("quota_saturated")
    start, end = epoch(sample_record["started_at"]), epoch(sample_record["finished_at"])
    if start is None or end is None or end >= a["resets_at"]:
        raise SafeError("sample_overlaps_or_follows_reset")
    if any(start < epoch(m["at"]) <= end for m in markers):
        raise SafeError("sample_overlaps_regime_change")
    regime = tuple(m["id"] for m in markers if epoch(m["at"]) <= start)
    daily = sample_record.get("daily", {}).get("data") or {}
    values = daily_credit_values(daily)
    return {
        "sample_id": sample_record["id"],
        "at": sample_record["finished_at"],
        "credits": sum(values.values()),
        "daily_values": values,
        "percent_low": a["used_percent"],
        "percent_high": b["used_percent"],
        "epoch_key": (
            sample_record["account_tag"],
            left["plan_type"],
            shape(left),
            a_slot,
            a["resets_at"],
            regime,
            tuple(sorted(values)),
        ),
        "plan_type": left["plan_type"],
        "resets_at": a["resets_at"],
        "freshness": daily.get("data_freshness_ts"),
    }


def infer(args):
    samples = sorted(
        read_records(args.data_dir / "samples.jsonl"),
        key=lambda s: epoch(s["started_at"]),
    )
    markers = sorted(
        read_records(args.data_dir / "regimes.jsonl"), key=lambda m: m["at"]
    )
    # Historical periods can reveal resets/plan changes between sparse samples.
    # Treat every returned boundary conservatively, even when history is approximate.
    history_boundaries = set()
    for record in samples:
        for period in record.get("history", {}).get("data", {}).get("periods", []):
            for key in ("starts_at", "ends_at"):
                at = timestamp(period.get(key))
                if at:
                    history_boundaries.add(at)
    markers.extend(
        {"id": "history-" + hashlib.sha256(at.encode()).hexdigest(), "at": at}
        for at in sorted(history_boundaries)
    )
    markers.sort(key=lambda m: m["at"])
    report = {
        "recorded_at": now(),
        "plus_reference_credits_per_week": Decimal("4989.7"),
        "status": "conditional_candidates_only",
        "assumptions": [
            "Daily credit analytics and quota snapshots measure the same usage and are temporally aligned.",
            "No hidden quota-regime change, unobserved reset, refund or analytics revision occurred within a segment.",
            "Integer percentage quantization is bounded by the selected rounding rule.",
        ],
        "windows": {},
    }
    for minutes, name in ((10080, "weekly"), (300, "five_hour")):
        groups = []
        rejected = []
        current = []
        previous = None
        for record in samples:
            try:
                obs = observation(record, minutes, args.rounding, markers)
            except SafeError as error:
                rejected.append({"sample_id": record["id"], "reason": str(error)})
                previous = None
                current = []
                continue
            changed = previous is None or obs["epoch_key"] != previous["epoch_key"]
            if previous is not None:
                changed |= obs["percent_low"] < previous["percent_high"]
                changed |= any(
                    obs["daily_values"].get(day, -1) < value
                    for day, value in previous["daily_values"].items()
                )
            if changed:
                current = []
                groups.append(current)
            current.append(obs)
            previous = obs
        segments = []
        for group in groups:
            result = fit_constraints(group, args.rounding)
            result.update(
                {
                    "sample_ids": [o["sample_id"] for o in group],
                    "plan_type": group[0]["plan_type"],
                    "resets_at": group[0]["resets_at"],
                    "analytics_freshness_available": all(o["freshness"] for o in group),
                }
            )
            if name == "weekly":
                result["pro5x_over_plus_reference"] = (
                    {
                        "lower": result.get("lower_credits") / Decimal("4989.7")
                        if result.get("lower_credits") is not None
                        else None,
                        "upper": result.get("upper_credits") / Decimal("4989.7")
                        if result.get("upper_credits") is not None
                        else None,
                    }
                    if group[0]["plan_type"] == "prolite"
                    else None
                )
            segments.append(result)
        report["windows"][name] = {"segments": segments, "rejected": rejected}
    if not any(window["segments"] for window in report["windows"].values()):
        report["status"] = "not_identifiable_from_available_observations"
    atomic_text(args.data_dir / "inference.json", json_text(report) + "\n")
    print(json_text(report))
    return 0


def mark_regime(args):
    at = timestamp(args.at)
    if at is None:
        raise SafeError("regime_timestamp_requires_timezone")
    record = {"id": uuid.uuid4().hex, "at": at, "name": args.name}
    append(args.data_dir / "regimes.jsonl", record)
    print(json_text(record))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir", type=Path, default=Path(__file__).resolve().parent / "data"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser(
        "scan",
        help="Export every local token_count event; preserve duplicate snapshots",
    )
    p.add_argument("--sessions", type=Path, default=Path.home() / ".codex/sessions")
    p.set_defaults(run=scan)
    p = sub.add_parser(
        "sample", help="GET quota, daily analytics, then quota again; no model requests"
    )
    p.add_argument("--auth", type=Path, default=Path.home() / ".codex/auth.json")
    p.add_argument(
        "--label", choices=("before", "after", "checkpoint"), default="checkpoint"
    )
    p.add_argument(
        "--history",
        action="store_true",
        help="Also collect optional plan limit history",
    )
    p.set_defaults(run=sample)
    p = sub.add_parser(
        "infer",
        help="Offline conditional interval fit; never merges reset/regime segments",
    )
    p.add_argument(
        "--rounding", choices=("unknown", "nearest", "floor", "ceil"), default="unknown"
    )
    p.set_defaults(run=infer)
    p = sub.add_parser(
        "mark-regime", help="Record a known regime boundary before running inference"
    )
    p.add_argument("--at", required=True)
    p.add_argument(
        "--name",
        required=True,
        choices=("quota-change", "plan-change", "manual-reset", "promotion-change"),
    )
    p.set_defaults(run=mark_regime)
    args = parser.parse_args(argv)
    try:
        private_dir(args.data_dir)
        with os.fdopen(
            private_open(args.data_dir / ".lock", os.O_CREAT | os.O_RDWR), "a"
        ) as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return args.run(args)
    except SafeError as error:
        print(json_text({"error": str(error)}), file=sys.stderr)
        return 1
    except Exception:  # noqa: BLE001 - last boundary against secret-bearing tracebacks
        print('{"error":"local_operation_failed_details_suppressed"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
