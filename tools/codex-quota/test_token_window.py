import json
import tempfile
import unittest
from copy import deepcopy
from decimal import Decimal
from pathlib import Path

import quota
import token_window


def usage(n, cached=0, output=0):
    return {
        "input_tokens": n,
        "cached_input_tokens": cached,
        "cache_write_input_tokens": 0,
        "output_tokens": output,
        "reasoning_output_tokens": 0,
        "total_tokens": n + output,
    }


def record(source="a", second=1, total=100, last=100, percent=0):
    return {
        "source_sha256": source,
        "source_line": second,
        "source_byte_offset": second,
        "timestamp": f"2026-09-20T00:00:{second:02}Z",
        "model": "gpt-6-astra",
        "service_tier": None,
        "total_token_usage": usage(total),
        "last_token_usage": usage(last),
        "rate_limits": {
            "plan_type": "prolite",
            "primary": {
                "window_minutes": 10080,
                "resets_at": 2000000000,
                "used_percent": percent,
            },
        },
    }


def sample(percent=10):
    q = record(percent=percent)["rate_limits"]
    return {
        "id": "sample",
        "started_at": "2026-09-20T00:00:40Z",
        "quota_before": {
            "started_at": "2026-09-20T00:00:40Z",
            "finished_at": "2026-09-20T00:00:41Z",
            "data": q,
        },
        "quota_after": {"data": deepcopy(q)},
        "daily": {
            "data": {
                "units": "percent",
                "data": [
                    {
                        "date": "2026-09-20",
                        "product_surface_usage_values": {"cli": 1, "work_web": 2},
                    }
                ],
            }
        },
    }


class TokenAccountingTests(unittest.TestCase):
    def test_multiple_parent_snapshots_restamped_at_fork_are_skipped(self):
        rows = [
            record(total=100, last=100),
            record(second=2, total=200, last=100),
            record("b", second=4, total=100, last=100),
            record("b", second=5, total=200, last=100),
            record("b", second=6, total=400, last=200),
        ]
        result, audit = token_window.account_tokens(
            rows, {"b": {"parent": "a", "created_at": "2026-09-20T00:00:03Z"}}
        )
        self.assertEqual(sum(r["usage"]["total_tokens"] for r in result), 400)
        self.assertEqual(audit["inherited_initial_snapshot_skipped"], 2)

    def test_idless_metadata_does_not_become_every_sessions_parent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, payload in (("a", {}), ("b", {"id": "ordinary"})):
                (root / (name + ".jsonl")).write_text(
                    json.dumps({"type": "session_meta", "payload": payload}) + "\n"
                )
            self.assertTrue(
                all(
                    m["parent"] is None
                    for m in token_window.source_metadata(root).values()
                )
            )

    def test_canonical_counter_disagreement_blocks_extrapolation(self):
        rows = [record(), record(second=20, total=1100, last=1000, percent=10)]
        canonical = [
            {
                "timestamp": "2026-09-20T00:00:19Z",
                "source_sha256": "a",
                "usage": usage(1000, cached=1),
                "model": "gpt-6-astra",
                "method": "canonical_response",
            }
        ]
        result, _ = token_window.estimate(
            rows, {}, sample(), canonical_loader=lambda start, end: canonical
        )
        self.assertEqual(result["status"], "accounting_incomplete")
        self.assertNotIn("endpoint_mix_extrapolation", result)

    def test_missing_reset_has_named_error(self):
        observed = sample()
        observed["quota_before"]["data"]["primary"]["resets_at"] = None
        with self.assertRaisesRegex(quota.SafeError, "reset_time_unavailable"):
            token_window.estimate([record()], {}, observed)

    def test_null_percentage_is_not_a_baseline(self):
        r = record()
        r["rate_limits"]["primary"]["used_percent"] = None
        with self.assertRaisesRegex(quota.SafeError, "no_same_window_baseline"):
            token_window.estimate([r], {}, sample())

    def test_monotone_diagnostic_removes_cross_source_reversals(self):
        rows = [
            record(),
            record(second=10, total=200, percent=5),
            record("b", second=11, total=100, percent=4),
            record(second=20, total=300, percent=6),
        ]
        result, _ = token_window.estimate(rows, {}, sample())
        self.assertTrue(
            result["constant_raw_token_denominator_test"]["ordering_sensitive"]
        )
        self.assertEqual(
            result["monotone_raw_token_denominator_test"]["points_removed"], 1
        )

    def test_fork_reemits_parent_last_request_without_new_usage(self):
        parent = record(total=1000, last=1000)
        parent_next = record(second=2, total=1100, last=100)
        restored = record("b", second=4, total=1100, last=100)
        metadata = {"b": {"parent": "a", "created_at": "2026-09-20T00:00:03Z"}}
        ledger, audit = token_window.account_tokens(
            [parent, parent_next, restored], metadata
        )
        self.assertEqual(sum(r["usage"]["total_tokens"] for r in ledger), 1100)
        self.assertEqual(audit["inherited_initial_snapshot_skipped"], 1)

    def test_one_request_parent_fork_is_not_a_fresh_counter(self):
        ledger, audit = token_window.account_tokens(
            [record(), record("b", second=3)],
            {"b": {"parent": "a", "created_at": "2026-09-20T00:00:02Z"}},
        )
        self.assertEqual(sum(r["usage"]["total_tokens"] for r in ledger), 100)
        self.assertEqual(audit["inherited_initial_snapshot_skipped"], 1)

    def test_canonical_records_deduplicate_response_ids_without_exporting_them(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            rows = [
                {"type": "turn_context", "payload": {"model": "gpt-6-astra"}},
                {
                    "timestamp": "2026-09-20T00:00:02Z",
                    "type": "token_usage_record",
                    "payload": {"response_id": "PRIVATE-RESPONSE", "usage": usage(100)},
                },
            ]
            content = "".join(json.dumps(r) + "\n" for r in rows)
            (path / "a.jsonl").write_text(content)
            (path / "b.jsonl").write_text(content)
            result = token_window.canonical_requests(
                path, "2026-09-20T00:00:01Z", "2026-09-20T00:00:03Z"
            )
            self.assertEqual(len(result), 1)
            self.assertNotIn("PRIVATE-RESPONSE", quota.json_text(result))

    def test_canonical_duplicate_keeps_earliest_observation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, second in (("a", 3), ("b", 2)):
                row = {
                    "timestamp": f"2026-09-20T00:00:0{second}Z",
                    "type": "token_usage_record",
                    "payload": {"response_id": "same-response", "usage": usage(100)},
                }
                (root / (name + ".jsonl")).write_text(json.dumps(row) + "\n")
            result = token_window.canonical_requests(
                root, "2026-09-20T00:00:01Z", "2026-09-20T00:00:04Z"
            )
            self.assertEqual(len(result), 1)
            self.assertEqual(
                quota.epoch(result[0]["timestamp"]),
                quota.epoch("2026-09-20T00:00:02Z"),
            )

    def test_canonical_replay_from_before_window_is_excluded_in_either_file_order(self):
        for seconds in ((1, 3), (3, 1)):
            with self.subTest(seconds=seconds), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                for name, second in zip(("a", "b"), seconds):
                    row = {
                        "timestamp": f"2026-09-20T00:00:0{second}Z",
                        "type": "token_usage_record",
                        "payload": {"response_id": "old-response", "usage": usage(100)},
                    }
                    (root / (name + ".jsonl")).write_text(json.dumps(row) + "\n")
                self.assertEqual(
                    token_window.canonical_requests(
                        root, "2026-09-20T00:00:02Z", "2026-09-20T00:00:04Z"
                    ),
                    [],
                )

    def test_canonical_compaction_and_delayed_snapshot_are_counted(self):
        counters, _ = token_window.account_tokens(
            [record(), record(second=20, total=200)], {}
        )
        canonical = [
            {**r, "method": "canonical_response", "response_sha256": str(i)}
            for i, r in enumerate(counters)
        ]
        canonical.append(
            {
                **canonical[-1],
                "timestamp": "2026-09-20T00:00:30Z",
                "usage": usage(50),
                "response_sha256": "compaction",
            }
        )
        reconciled, audit = token_window.reconcile_requests(counters, canonical)
        self.assertEqual(sum(r["usage"]["total_tokens"] for r in reconciled), 250)
        self.assertEqual(audit["canonical_without_counter_snapshot"], 1)
        self.assertEqual(audit["counter_fallback_requests"], 0)

    def test_counter_fills_one_missing_response_without_recounting_matched_requests(
        self,
    ):
        counters, _ = token_window.account_tokens(
            [record(), record(second=20, total=300, last=200)], {}
        )
        canonical = [{**counters[0], "method": "canonical_response"}]
        reconciled, audit = token_window.reconcile_requests(counters, canonical)
        self.assertEqual(sum(r["usage"]["total_tokens"] for r in reconciled), 300)
        self.assertEqual(audit["counter_fallback_requests"], 1)

    def test_canonical_request_from_another_epoch_blocks_fit(self):
        records = [
            record(),
            record(second=20, total=1100, last=1000, percent=10),
            record("other", second=30),
        ]
        records[-1]["rate_limits"]["plan_type"] = "plus"
        canonical = [
            {
                "timestamp": "2026-09-20T00:00:30Z",
                "source_sha256": "other",
                "usage": usage(100),
                "model": "gpt-6-astra",
                "method": "canonical_response",
            }
        ]
        result, _ = token_window.estimate(
            records, {}, sample(), canonical_loader=lambda start, end: canonical
        )
        self.assertEqual(result["status"], "accounting_incomplete")

    def test_fresh_delta_and_unchanged_snapshot(self):
        ledger, audit = token_window.account_tokens(
            [record(), record(second=2, total=200), record(second=3, total=200)], {}
        )
        self.assertEqual(sum(r["usage"]["input_tokens"] for r in ledger), 200)
        self.assertEqual(audit["unchanged_cumulative_snapshot"], 1)

    def test_compaction_context_size_is_not_a_billable_increment(self):
        compacted = record(second=2)
        compacted["last_token_usage"] = usage(0)
        compacted["last_token_usage"]["total_tokens"] = 21653
        ledger, audit = token_window.account_tokens(
            [record(), compacted, record(second=3, total=200)], {}
        )
        self.assertEqual(len(ledger), 2)
        self.assertEqual(sum(r["usage"]["total_tokens"] for r in ledger), 200)
        self.assertEqual(audit["unchanged_cumulative_snapshot"], 1)

    def test_fork_first_request_counts_only_new_tokens(self):
        parent = record(total=1000, last=1000)
        child = record("b", second=3, total=1100, last=100)
        metadata = {"b": {"parent": "a", "created_at": "2026-09-20T00:00:02Z"}}
        ledger, _ = token_window.account_tokens([parent, child], metadata)
        self.assertEqual(ledger[-1]["method"], "verified_fork_baseline")
        self.assertEqual(sum(r["usage"]["total_tokens"] for r in ledger), 1100)

    def test_unknown_inherited_baseline_remains_unresolved(self):
        ledger, _ = token_window.account_tokens([record(total=1000, last=100)], {})
        self.assertIsNone(ledger[0]["usage"])
        self.assertEqual(ledger[0]["method"], "unresolved_initial_counter")

    def test_future_parent_counter_cannot_validate_a_fork(self):
        ledger, _ = token_window.account_tokens(
            [
                record(second=4, total=1000, last=1000),
                record("b", second=3, total=1100),
            ],
            {"b": {"parent": "a", "created_at": "2026-09-20T00:00:02Z"}},
        )
        self.assertEqual(ledger[0]["method"], "unresolved_initial_counter")

    def test_replayed_prefix_before_creation_is_skipped(self):
        ledger, audit = token_window.account_tokens(
            [record(), record(second=3, total=100, last=100)],
            {"a": {"created_at": "2026-09-20T00:00:02Z"}},
        )
        self.assertEqual(len(ledger), 1)
        self.assertEqual(audit["inherited_history_records_skipped"], 1)

    def test_counter_rewind_and_missing_events_are_not_hidden(self):
        for next_record, expected in (
            (record(second=2, total=50, last=50), "counter_decreased"),
            (
                record(second=2, total=400, last=100),
                "delta_does_not_match_last_request",
            ),
        ):
            ledger, _ = token_window.account_tokens([record(), next_record], {})
            self.assertEqual(ledger[-1]["method"], expected)
            self.assertIsNone(ledger[-1]["usage"])

    def test_exact_sample_interval_excludes_baseline_and_later_work(self):
        records = [
            record(),
            record(second=20, total=1100, last=1000, percent=10),
            record(second=50, total=2100, last=1000, percent=20),
        ]
        report, ledger = token_window.estimate(records, {}, sample())
        self.assertEqual(report["totals"]["total_tokens"], 1000)
        self.assertEqual(len(ledger), 1)
        self.assertEqual(report["nominal_mix_extrapolation"], 10000)
        bound = report["endpoint_mix_extrapolation"]
        self.assertLess(bound["lower"], 10000)
        self.assertGreater(bound["upper"], 10000)
        self.assertEqual(report["other_surfaces_observed"], ["work_web"])
        self.assertIsNone(report["absolute_credit_denominator"])

    def test_reset_and_plan_change_fail_the_interval(self):
        for changed in ("plan", "reset"):
            records = [record(), record(second=20, total=1100, last=1000, percent=10)]
            if changed == "plan":
                records[-1]["rate_limits"]["plan_type"] = "pro"
            else:
                records[-1]["rate_limits"]["primary"]["resets_at"] += 1
            report, _ = token_window.estimate(records, {}, sample())
            self.assertEqual(report["status"], "accounting_incomplete")
            self.assertNotIn("endpoint_mix_extrapolation", report)

    def test_known_regime_marker_blocks_a_crossing(self):
        with self.assertRaisesRegex(quota.SafeError, "regime_change"):
            token_window.estimate(
                [record(), record(second=20, total=1100, last=1000, percent=10)],
                {},
                sample(),
                markers=[{"at": "2026-09-20T00:00:10Z"}],
            )

    def test_same_source_quota_decrease_invalidates_fit(self):
        records = [
            record(),
            record(second=10, total=200, percent=5),
            record(second=20, total=300, percent=4),
        ]
        report, _ = token_window.estimate(records, {}, sample())
        self.assertEqual(report["status"], "accounting_incomplete")

    def test_credit_equivalent_does_not_double_count_cached_or_reasoning(self):
        rows = [record(), record(second=20, total=200, last=100, percent=10)]
        rows[1]["total_token_usage"] = usage(200, cached=80, output=20)
        rows[1]["last_token_usage"] = usage(100, cached=80, output=20)
        rows[1]["total_token_usage"]["reasoning_output_tokens"] = 10
        rows[1]["last_token_usage"]["reasoning_output_tokens"] = 10
        report, _ = token_window.estimate(rows, {}, sample())
        self.assertEqual(
            report["astra_only_credit_equivalent"]["standard_scenario"],
            Decimal("0.032"),
        )
        self.assertFalse(
            report["astra_only_credit_equivalent"]["included_quota_weighting_verified"]
        )

    def test_no_five_hour_observations_is_explicit(self):
        with self.assertRaisesRegex(quota.SafeError, "window_not_exposed"):
            token_window.estimate([record()], {}, sample(), minutes=300)


if __name__ == "__main__":
    unittest.main()
