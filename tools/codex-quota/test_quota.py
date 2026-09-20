import argparse
import io
import json
import random
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import quota


def window(percent=10, reset=2000000000, minutes=10080):
    return {"used_percent": percent, "window_minutes": minutes, "resets_at": reset}


def daily(credits=100):
    return {
        "units": "credits",
        "group_by": "day",
        "unknown_surface_count": 0,
        "data": [
            {"date": "2026-09-18", "product_surface_usage_values": {"cli": credits}}
        ],
    }


def sample(
    identifier="a",
    percent=10,
    credits=100,
    at="2026-09-18T00:00:00Z",
    reset=2000000000,
    account="local-tag",
):
    limits = {
        "plan_type": "prolite",
        "primary": window(percent, reset),
        "secondary": None,
    }
    return {
        "id": identifier,
        "account_tag": account,
        "started_at": at,
        "finished_at": at,
        "quota_before": {"data": limits},
        "quota_after": {"data": limits},
        "daily": {"data": daily(credits)},
    }


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_decimal_round_trip(self):
        raw = '{"credits":0.1234567890123456789123456789}'
        self.assertEqual(quota.json_text(quota.decode(raw)), raw)

    def test_projection_excludes_credentials(self):
        data = {
            "account_id": "ACCOUNT-SECRET",
            "email": "EMAIL-SECRET",
            "plan_type": "prolite",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 86,
                    "limit_window_seconds": 604800,
                    "reset_at": 2000000000,
                }
            },
        }
        text = quota.json_text(quota.limits_projection(data, True))
        self.assertNotIn("SECRET", text)
        self.assertEqual(quota.decode(text)["primary"]["window_minutes"], 10080)

    def test_daily_retains_decimal_numbers_not_identity(self):
        data = daily(Decimal("123.00000000000000019"))
        data["data"][0].update(
            {
                "account_id": 918271,
                "models": [
                    {
                        "model": "gpt-6-astra",
                        "credits": Decimal("42.125"),
                        "account_id": 918271,
                        "access_token": "SECRET",
                    }
                ],
            }
        )
        projected = quota.daily_projection(data)
        self.assertNotIn("918271", quota.json_text(projected))
        self.assertNotIn("SECRET", quota.json_text(projected))
        self.assertEqual(
            projected["data"][0]["models"][0]["credits"], Decimal("42.125")
        )
        self.assertEqual(
            quota.daily_credit_values(projected)["2026-09-18"],
            Decimal("123.00000000000000019"),
        )

    def test_unknown_surfaces_preserve_numeric_values_but_block_fit(self):
        data = daily()
        data["data"][0]["product_surface_usage_values"]["PRIVATE-IDENTIFIER"] = Decimal(
            "3.125"
        )
        projected = quota.daily_projection(data)
        self.assertNotIn("PRIVATE-IDENTIFIER", quota.json_text(projected))
        self.assertIn("3.125", quota.json_text(projected))
        with self.assertRaisesRegex(quota.SafeError, "schema_not_supported"):
            quota.daily_credit_values(projected)

    def test_history_drops_account_and_period_ids(self):
        projected = quota.history_projection(
            {
                "account_id": "SECRET",
                "periods": [
                    {
                        "id": "SECRET",
                        "plan_type": "prolite",
                        "used_basis_points": Decimal("8550.125"),
                        "starts_at": "2026-09-18T00:00:00Z",
                    }
                ],
            }
        )
        self.assertNotIn("SECRET", quota.json_text(projected))
        self.assertTrue(projected["approximate"])
        self.assertEqual(
            projected["periods"][0]["used_basis_points"], Decimal("8550.125")
        )

    def test_scan_preserves_every_snapshot_and_skips_partial_line(self):
        sessions = self.root / "sessions"
        sessions.mkdir()
        rows = [
            {
                "type": "turn_context",
                "payload": {"model": "gpt-6-astra", "unrelated_secret": "SECRET"},
            },
            {
                "timestamp": "2026-09-18T00:00:00Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 100,
                            "cached_input_tokens": 60,
                        },
                        "last_token_usage": {"input_tokens": 25},
                    },
                    "rate_limits": {"plan_type": "prolite", "primary": window()},
                },
            },
        ]
        path = sessions / "rollout.jsonl"
        path.write_text(
            "\n".join(json.dumps(row) for row in (rows + [rows[1]])) + '\n{"partial":'
        )
        output = self.root / "output"
        output.mkdir()
        args = argparse.Namespace(sessions=sessions, data_dir=output)
        with redirect_stdout(io.StringIO()):
            quota.scan(args)
        events = quota.read_records(output / "rollouts.jsonl")
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["model"], "gpt-6-astra")
        self.assertNotEqual(
            events[0]["source_byte_offset"], events[1]["source_byte_offset"]
        )
        self.assertNotIn("SECRET", (output / "rollouts.jsonl").read_text())
        self.assertIn(
            "total_token_usage.cached_input_tokens",
            (output / "rollouts.csv").read_text(),
        )
        self.assertEqual(
            quota.decode((output / "scan.json").read_text())["partial_lines_skipped"], 1
        )
        before = (output / "rollouts.jsonl").read_bytes()
        with redirect_stdout(io.StringIO()):
            quota.scan(args)
        self.assertEqual(before, (output / "rollouts.jsonl").read_bytes())
        self.assertEqual((output / "rollouts.jsonl").stat().st_mode & 0o777, 0o600)

    def test_scan_emits_null_usage_event(self):
        path = self.root / "rollout.jsonl"
        path.write_text(
            json.dumps(
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": None,
                        "rate_limits": None,
                    },
                }
            )
            + "\n"
        )
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
        events = list(quota.rollout_records(self.root, stats))
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]["total_token_usage"])

    def test_sample_brackets_daily_and_records_unavailable_analytics(self):
        calls = []

        class Client:
            account_tag = "local"

            def __init__(self, *args):
                pass

            def get(self, endpoint):
                calls.append(endpoint)
                return (
                    {"http_status": 403, "error": "http_error"}
                    if endpoint == "daily"
                    else {"data": {}}
                )

        with (
            patch.object(quota, "AccountClient", Client),
            redirect_stdout(io.StringIO()),
        ):
            quota.sample(
                argparse.Namespace(
                    auth=Path("unused"),
                    data_dir=self.root,
                    label="before",
                    history=False,
                )
            )
        self.assertEqual(calls, ["quota", "daily", "quota"])
        record = quota.read_records(self.root / "samples.jsonl")[0]
        self.assertEqual(record["daily"]["http_status"], 403)

    def make_client(self):
        auth = self.root / "auth.json"
        auth.write_text(
            json.dumps(
                {
                    "tokens": {
                        "access_token": "ACCESS-SECRET",
                        "refresh_token": "REFRESH-SECRET",
                        "account_id": "ACCOUNT-SECRET",
                    }
                }
            )
        )
        return quota.AccountClient(auth, self.root)

    def test_client_get_is_fixed_origin_read_only(self):
        client = self.make_client()
        requests = []

        class Response(io.BytesIO):
            status = 200

        def open_request(request, **kwargs):
            requests.append(request)
            return Response(b'{"plan_type":"prolite","account_id":"ACCOUNT-SECRET"}')

        with patch.object(client.opener, "open", open_request):
            result = client.get("quota")
        self.assertEqual(requests[0].method, "GET")
        self.assertEqual(requests[0].full_url, quota.BASE)
        self.assertNotIn("SECRET", quota.json_text(result))
        self.assertFalse(any(k.lower() == "cookie" for k in requests[0].headers))
        with self.assertRaises(quota.SafeError):
            client.get("https://attacker.invalid")

    def test_client_never_prints_network_error_text(self):
        client = self.make_client()
        with patch.object(
            client.opener, "open", side_effect=RuntimeError("ACCESS-SECRET")
        ):
            result = client.get("quota")
        self.assertEqual(result["error"], "network_or_json_error")
        self.assertNotIn("SECRET", quota.json_text(result))

    def test_http_error_does_not_read_or_save_body(self):
        client = self.make_client()
        body = io.BytesIO(b"ACCOUNT-SECRET")
        error = urllib.error.HTTPError(quota.BASE, 401, "ACCESS-SECRET", {}, body)
        with patch.object(client.opener, "open", side_effect=error):
            result = client.get("quota")
        self.assertEqual(result["http_status"], 401)
        self.assertNotIn("SECRET", quota.json_text(result))
        self.assertTrue(body.closed)

    def test_redirects_are_not_followed(self):
        self.assertIsNone(
            quota.NoRedirect().redirect_request(
                None, None, 302, "", {}, "https://attacker.invalid"
            )
        )

    def test_secret_in_unexpected_categorical_field_is_removed(self):
        client = self.make_client()
        self.assertEqual(
            client.exclude_secrets({"model": "ACCOUNT-SECRET"}), {"model": None}
        )

    def test_account_binding_changes_without_recording_id(self):
        first = self.make_client().account_tag
        self.assertEqual(first, self.make_client().account_tag)
        auth = self.root / "auth.json"
        auth.write_text(
            json.dumps(
                {"tokens": {"access_token": "NEW-ACCESS", "account_id": "NEW-ACCOUNT"}}
            )
        )
        second = quota.AccountClient(auth, self.root).account_tag
        self.assertNotEqual(first, second)
        self.assertNotIn("ACCOUNT", first + second)

    def test_symlink_writes_are_rejected(self):
        target = self.root / "target"
        target.write_text("untouched")
        link = self.root / "link"
        link.symlink_to(target)
        with self.assertRaises(OSError):
            quota.append(link, {"a": 1})
        self.assertEqual(target.read_text(), "untouched")

    def test_auth_error_is_sanitized(self):
        auth = self.root / "auth.json"
        auth.write_text("PRIVATE-CONTENT")
        with self.assertRaisesRegex(
            quota.SafeError, "auth_unavailable_no_refresh_attempted"
        ):
            quota.AccountClient(auth, self.root)

    def test_global_error_is_sanitized(self):
        output = io.StringIO()
        with (
            patch.object(quota, "private_dir", side_effect=RuntimeError("SECRET")),
            redirect_stderr(output),
        ):
            self.assertEqual(quota.main(["scan"]), 1)
        self.assertNotIn("SECRET", output.getvalue())


class InferenceTests(unittest.TestCase):
    def test_ground_truth_survives_multiple_quantizers_and_offsets(self):
        rng = random.Random(17)
        for rounding in ("nearest", "floor", "ceil", "unknown"):
            for _ in range(50):
                denominator = Decimal(rng.randrange(500, 100000))
                offset = Decimal(rng.randrange(1000))
                fractions = sorted(
                    Decimal(rng.randrange(100, 9900)) / 10000 for _ in range(8)
                )
                rows = []
                for fraction in fractions:
                    true_percent = fraction * 100
                    if rounding == "floor":
                        shown = int(true_percent)
                    elif rounding == "ceil":
                        shown = int(
                            true_percent.to_integral_value(rounding="ROUND_CEILING")
                        )
                    else:
                        shown = round(true_percent)
                    rows.append(
                        {
                            "credits": offset + fraction * denominator,
                            "percent_low": shown,
                            "percent_high": shown,
                        }
                    )
                fitted = quota.fit_constraints(rows, rounding)
                self.assertEqual(fitted["status"], "bounded")
                self.assertLessEqual(fitted["lower_credits"], denominator)
                self.assertGreaterEqual(fitted["upper_credits"], denominator)

    def test_rollout_boundary_is_conservative(self):
        before = {"plan_type": "prolite", "primary": window(percent=10)}
        after = {"plan_type": "prolite", "primary": window(percent=1, reset=2000000001)}
        reasons = quota.boundary_reasons(before, after)
        self.assertIn("primary.reset_at_changed", reasons)
        self.assertIn("primary.usage_decreased_possible_reset_or_stale_read", reasons)

    def test_percent_analytics_do_not_become_credits_from_field_name(self):
        record = sample()
        record["daily"]["data"]["units"] = "percent"
        record["daily"]["data"]["data"][0]["models"] = [
            {"model": "gpt-6-astra", "credits": 100}
        ]
        report = self.run_infer([record])
        self.assertEqual(
            report["status"], "not_identifiable_from_available_observations"
        )
        self.assertEqual(
            report["windows"]["weekly"]["rejected"][0]["reason"],
            "daily_units_not_credits",
        )
        self.assertFalse(report["windows"]["weekly"]["segments"])

    def test_complete_five_hour_fit_is_independent_of_weekly(self):
        a = sample()
        b = sample("b", 20, 1100, "2026-09-18T01:00:00Z")
        a["quota_before"]["data"]["secondary"] = window(percent=10, minutes=300)
        b["quota_before"]["data"]["secondary"] = window(percent=30, minutes=300)
        report = self.run_infer([a, b])
        weekly = report["windows"]["weekly"]["segments"][0]
        five_hour = report["windows"]["five_hour"]["segments"][0]
        self.assertLess(five_hour["upper_credits"], weekly["lower_credits"])

    def test_regime_change_inside_sample_is_rejected(self):
        record = sample()
        record["finished_at"] = "2026-09-18T01:00:00Z"
        markers = [{"id": "change", "at": "2026-09-18T00:30:00Z"}]
        with self.assertRaisesRegex(quota.SafeError, "sample_overlaps_regime_change"):
            quota.observation(record, 10080, "unknown", markers)

    def test_window_selection_uses_duration(self):
        r = sample()["quota_before"]["data"]
        self.assertEqual(quota.pick_window(r, 10080)[0], "primary")
        self.assertIsNone(quota.pick_window(r, 300)[1])

    def test_interval_fit_recovers_known_denominator(self):
        rows = [
            {"credits": Decimal(c), "percent_low": p, "percent_high": p}
            for c, p in (("500", 5), ("5000", 50), ("9500", 95))
        ]
        result = quota.fit_constraints(rows, "nearest")
        self.assertEqual(result["status"], "bounded")
        self.assertLessEqual(result["lower_credits"], 10000)
        self.assertGreaterEqual(result["upper_credits"], 10000)
        self.assertLess(result["upper_credits"] - result["lower_credits"], 225)

    def test_rounding_ambiguity_is_not_exact_five_percent(self):
        rows = [
            {"credits": c, "percent_low": p, "percent_high": p}
            for c, p in ((0, 0), (500, 5))
        ]
        result = quota.fit_constraints(rows)
        self.assertLess(result["lower_credits"], 10000)
        self.assertGreater(result["upper_credits"], 10000)

    def test_unmoved_percent_only_provides_lower_bound(self):
        result = quota.fit_constraints(
            [{"credits": c, "percent_low": 5, "percent_high": 5} for c in (100, 150)]
        )
        self.assertEqual(result["status"], "lower_bound_only")
        self.assertEqual(result["lower_credits"], 2500)
        self.assertIsNone(result["upper_credits"])

    def test_stale_credits_conflict_with_large_percent_jump(self):
        result = quota.fit_constraints(
            [{"credits": 100, "percent_low": p, "percent_high": p} for p in (5, 10)]
        )
        self.assertEqual(result["status"], "inconsistent")

    def test_sample_reset_is_rejected(self):
        record = sample()
        record["quota_after"] = {
            "data": {"plan_type": "prolite", "primary": window(reset=2000000001)}
        }
        with self.assertRaisesRegex(quota.SafeError, "reset_changed"):
            quota.observation(record, 10080, "unknown", [])

    def test_saturated_quota_is_rejected(self):
        with self.assertRaisesRegex(quota.SafeError, "quota_saturated"):
            quota.observation(sample(percent=100), 10080, "unknown", [])

    def test_units_are_checked(self):
        record = sample()
        record["daily"]["data"]["units"] = "tokens"
        with self.assertRaisesRegex(quota.SafeError, "units_not_credits"):
            quota.observation(record, 10080, "unknown", [])

    def run_infer(self, records, markers=()):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            for record in records:
                quota.append(path / "samples.jsonl", record)
            for marker in markers:
                quota.append(path / "regimes.jsonl", marker)
            with redirect_stdout(io.StringIO()):
                quota.infer(argparse.Namespace(data_dir=path, rounding="unknown"))
            return quota.decode((path / "inference.json").read_text())

    def test_reset_account_plan_and_shape_each_split_segments(self):
        for changed in (
            "reset",
            "account",
            "plan",
            "shape",
            "decrease",
            "revision",
            "dates",
        ):
            with self.subTest(changed=changed):
                a = sample()
                b = sample("b", 20, 1100, "2026-09-18T01:00:00Z")
                if changed == "reset":
                    b["quota_before"]["data"]["primary"]["resets_at"] += 1
                if changed == "account":
                    b["account_tag"] = "different"
                if changed == "plan":
                    b["quota_before"]["data"]["plan_type"] = "pro"
                if changed == "shape":
                    b["quota_before"]["data"]["secondary"] = window(minutes=300)
                if changed == "decrease":
                    b["quota_before"]["data"]["primary"]["used_percent"] = 9
                if changed == "revision":
                    b["daily"]["data"]["data"][0]["product_surface_usage_values"][
                        "cli"
                    ] = 50
                if changed == "dates":
                    b["daily"]["data"]["data"][0]["date"] = "2026-09-19"
                report = self.run_infer([a, b])
                self.assertEqual(len(report["windows"]["weekly"]["segments"]), 2)

    def test_known_regime_change_splits_even_if_reset_is_same(self):
        report = self.run_infer(
            [sample(), sample("b", 20, 1100, "2026-09-18T01:00:00Z")],
            [{"id": "change", "at": "2026-09-18T00:30:00Z"}],
        )
        self.assertEqual(len(report["windows"]["weekly"]["segments"]), 2)

    def test_history_boundaries_split_segments(self):
        b = sample("b", 20, 1100, "2026-09-18T01:00:00Z")
        b["history"] = {"data": {"periods": [{"starts_at": "2026-09-18T00:30:00Z"}]}}
        report = self.run_infer([sample(), b])
        self.assertEqual(len(report["windows"]["weekly"]["segments"]), 2)

    def test_five_hour_absence_and_reference_ratio(self):
        report = self.run_infer(
            [sample(), sample("b", 20, 1100, "2026-09-18T01:00:00Z")]
        )
        weekly = report["windows"]["weekly"]["segments"][0]
        self.assertEqual(weekly["status"], "bounded")
        self.assertEqual(
            weekly["pro5x_over_plus_reference"]["lower"],
            weekly["lower_credits"] / Decimal("4989.7"),
        )
        self.assertFalse(report["windows"]["five_hour"]["segments"])
        self.assertEqual(
            report["windows"]["five_hour"]["rejected"][0]["reason"],
            "window_not_exposed",
        )

    def test_invalid_intermediate_sample_does_not_bridge_segments(self):
        bad = sample("bad", at="2026-09-18T00:30:00Z")
        bad["daily"] = {"http_status": 403}
        report = self.run_infer(
            [sample(), bad, sample("b", 20, 1100, "2026-09-18T01:00:00Z")]
        )
        self.assertEqual(len(report["windows"]["weekly"]["segments"]), 2)


if __name__ == "__main__":
    unittest.main()
