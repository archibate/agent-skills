# Local Codex quota recorder

Python 3.10+ standard library; Linux. Reads local rollouts and makes authenticated
GET requests to fixed official usage URLs. It never starts Codex work, buys credits,
refreshes credentials, changes account settings, or installs background jobs.

From this directory:

```bash
uv run --offline python quota.py scan
uv run --offline python quota.py sample --label before --history
# Do your ordinary Codex work.
uv run --offline python quota.py sample --label after
uv run --offline python quota.py infer
```

Run `sample` again around later ordinary work to accumulate observations. Each
sample reads quota, daily analytics, then quota again to bracket concurrent work.
`--history` additionally tries the optional historical-period GET; a 404 is saved
as unavailable. There is no polling or workload generator.

Default output is `data/` beside the script, ignored by Git. To choose another
location, put `--data-dir /path/to/local/data` **before** the subcommand. Directories
are mode 0700 and files 0600. The recorder serializes concurrent local commands.

| File | Contents |
| --- | --- |
| `rollouts.jsonl`, `rollouts.csv` | Every `event_msg/token_count`, including duplicate cumulative snapshots and events with null usage; both total/last token objects, cached/input/output/reasoning counts, model context, quota slots and plan type |
| `rollout_boundaries.jsonl` | Per-source reset-time, plan, window and decreasing-percentage boundaries; decreases may also indicate stale reads |
| `scan.json` | File/event counts, malformed or partial lines skipped |
| `samples.jsonl` | Append-only API observations, request start/end times, numeric daily analytics, units, optional history and sanitized failures |
| `regimes.jsonl` | Explicitly recorded known changes |
| `inference.json` | Offline interval results, exclusions, assumptions and weekly comparison with 4,989.7 |

`scan` rebuilds exports atomically per file from `~/.codex/sessions/**/*.jsonl`;
it does not modify source files. Source provenance is SHA-256 of the rollout path
relative to the sessions directory, plus original line and byte offset. A partial
last line is deferred until the next scan. Cumulative snapshots, inherited fork
counters and reasoning-token subsets are retained, **never summed into credits**.
Historical rollouts have unknown account attribution and are not joined to the
authenticated credit fit. `source_epoch` only segments one source file.

Authentication comes from `~/.codex/auth.json` in process memory. Only the existing
access token and account header are sent, over HTTPS to `chatgpt.com`; redirects
are refused and no cookies or reserve opt-in headers are used. The machine's
configured HTTPS proxy is honored. Responses are projected onto usage fields:
account/user IDs, email, credentials, arbitrary strings, HTTP bodies on failure,
headers and exception text are excluded. The recorder does not save a complete
account response. A local salted HMAC binds samples to the same account without
storing the account ID; `.account-salt` stays with the collection.

Numerical API values are parsed as `Decimal` and serialized without float
rounding. Known daily surface/model maps keep their field names. Other numerical
usage leaves retain their structural positions (zero-based dictionary insertion
order and array indices), while unknown keys and string values are omitted.
These positional leaves are archival only; unsupported surfaces block inference.
HTTP success does not establish that analytics are current or credit-denominated.

## Inference boundaries

Windows are identified by duration: 300 minutes and 10080 minutes. Either can
appear in either quota slot. An absent window is reported as `window_not_exposed`.
The tier's advertised multiplier is never used as a denominator or prior.

The automatic fit requires daily analytics with `units: "credits"`. A field named
`models[].credits` is not sufficient: personal-account responses can label the
entire dataset `units: "percent"`. Such observations are preserved but rejected
with `daily_units_not_credits`. Purchased-credit balances are also not treated as
included allowance consumption. No conversion from token pricing is fabricated.

For each valid sample, let `C_i` be the sum of its daily credit values and
`[l_i, h_i]` the quota fraction interval. An unknown initial offset cancels:

```text
C_j - C_i = allowance * (fraction_j - fraction_i)
allowance >= (C_j - C_i) / (h_j - l_i)
allowance <= (C_j - C_i) / (l_j - h_i)   when l_j > h_i
```

The implementation intersects constraints from **all observation pairs** within
each segment. No midpoint is promoted to an exact measured denominator. `infer`
defaults to conservative integer-quantization bounds of ±1 percentage point
(covering floor, nearest and ceiling); `--rounding nearest|floor|ceil` runs an
explicit assumption. Bounds include endpoints conservatively. Unchanged
percentages may yield only a lower bound; inconsistent constraints are reported.

Segments split on account binding, plan type, window layout, reset timestamp,
percentage decrease, daily date coverage change, decreasing daily totals,
unavailable intermediate data, recorded regime changes, or observed historical
period boundaries. Saturated quotas and samples crossing a reset/change are
excluded. Segments are never pooled, including across distinct resets.

Record a known OpenAI quota-regime change at its actual effective timestamp:

```bash
uv run --offline python quota.py mark-regime \
  --at 2026-09-18T12:00:00+08:00 --name quota-change
uv run --offline python quota.py infer
```

Other marker names are `plan-change`, `manual-reset`, and `promotion-change`.
Existing observations remain intact and are resegmented. Unannounced server-side
changes and unobserved resets that leave no evidence cannot be detected reliably.

Even a finite interval is a **conditional candidate** until analytics and quota
are shown to cover the same usage and time interval. Delayed/backfilled daily
analytics, shared usage from other clients/features, and unknown quota changes
can invalidate that correspondence. The recorder keeps freshness metadata when
available and does not invent freshness for responses lacking it.

Weekly Pro 5x candidates (this account's observed wire plan is `prolite`) include
the interval divided by the user-supplied Plus reference of **4,989.7 credits/week**.
That reference is a comparison value, not an independently validated constant.

## Validation and source contracts

```bash
uv run --offline python -m unittest discover -s . -p 'test_*.py'
ruff check .
ruff format --check .
```

Tests use synthetic credentials and mocked HTTP, not model requests or real auth.

The endpoints are internal and can change. The implementation follows official
Codex source for [authentication and window conversion](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs),
[daily analytics requests](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/analytics.rs),
[daily schemas](https://github.com/openai/codex/blob/main/codex-rs/codex-backend-openapi-models/src/models/analytics.rs),
[unit normalization](https://github.com/openai/codex/blob/main/codex-rs/tui/src/analytics/normalize.rs),
and [optional plan history](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/plan_history.rs).
