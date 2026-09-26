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

## Token-based cross-check

```bash
uv run --offline python token_window.py
```

This offline check uses the latest saved account sample and the earliest matching
rollout quota observation in that reset period. It counts `token_usage_record`
requests once per hashed response ID, including real compaction calls and requests
whose cumulative snapshot was delayed. Responses observed before the start are
excluded even if a fork repeats them with a timestamp inside the interval.
Cumulative token deltas provide a separate
cross-check and supplement missing response records; inherited fork baselines are
verified against the parent before counting the fork's first request. Restored
parent snapshots are skipped until the fork produces new usage, including
multi-record replays stamped at fork time. Unchanged
counter snapshots add no usage, although a separate compaction request may still
be billable. Malformed, rewound or unexplained counters remain visible and block
extrapolation. Unmatched counter candidates alongside canonical responses also
block extrapolation because they could describe the same request differently.
The source JSONLs are read locally; exports contain numerical usage, model labels,
timestamps, hashed provenance and the already-projected quota fields (including
plan and numerical credit balance).

`data/token_window_events.jsonl` is the auditable request ledger;
`data/token_window.json` contains uncached/cached input, output, model breakdowns,
and a conditional endpoint extrapolation in **tokens per 100% allowance**.
Canonical requests without a matching counter snapshot retain null quota fields:
they contribute tokens but no intermediate percentage point, and their quota
epoch is checked against the nearest same-source counter. Such records can reflect
compaction, delayed snapshots, boundary timing or fork copies; unavailable or
different epochs block extrapolation, and an earlier original response is required
to detect a restamped fork copy.
It also
tests all percentage observations against a single raw-token denominator; an
inconsistent fit does not establish a constant-rate model. Since asynchronous
quota reads can be out of order, a second diagnostic drops falling-percentage
points and fits the remaining monotone subsequence. Raw token
counts depend on the model/cache/output mix and are not an absolute credit budget.

Known regime boundaries and changed plans/reset times are rejected. Same-source
percentage decreases block the fit; cross-source reversals are recorded as timing
warnings and require the explicit assumption that the readings are stale rather
than hidden resets. Endpoint GET duration is retained as timing uncertainty.

Web/mobile use in the saved account analytics is reported because it is missing
from this machine's token logs. Account attribution and per-request speed also
remain unverified. Astra-only Standard/Fast credit-equivalent scenarios use the
[current official rate card](https://learn.chatgpt.com/docs/pricing), leave
`codex-auto-review` unpriced, and do not assert that purchased-credit rates match
included-quota weights. The script does not divide token units by the Plus credit
reference or replace the direct-credit inference result.
The rate card specifies no separate cache-write credit surcharge; the report
retains the observed cache-write count rather than inventing an additional fee.

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
