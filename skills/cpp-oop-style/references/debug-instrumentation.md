# Log-Based Debug Instrumentation

Use debug instrumentation to turn a tacit symptom into discriminating evidence.
Keep the production control flow intact and prefer one comprehensive observation
over a sequence of narrow guesses.

## Plan one discriminating capture

Before reproducing the bug:

1. Enumerate every state that could plausibly produce the symptom, including
   low-probability cases.
2. Identify the inputs, state transitions, branch decisions, sequence IDs,
   timestamps, and errors that distinguish those cases.
3. Capture those fields together in one structured observation.
4. Run the original reproduction and retain its inputs and output as evidence.

If two instrument -> rebuild -> observe cycles still do not locate the culprit,
stop changing source merely to vary observation. Read `debug-harnesses.md` and
move the investigation into a controllable harness, REPL, or batched runner.

## Capture enough state in one run

Do not omit a plausible discriminator merely because it appears unlikely. Record
the complete, deliberately enumerated set needed to distinguish the hypotheses.
Prefer named fields and stable event/result types over prose-only messages.

Useful fields commonly include:

- input identity and a bounded summary of its value;
- pre-state, post-state, and the transition or branch reason;
- correlation, request, frame, or sequence identifiers;
- monotonic timestamps when event order or delay matters; and
- the returned value, error category, and relevant dependency state.

Keep protocol data on stdout or in a structured file and human lifecycle
diagnostics on stderr. Do not dump secrets, unrelated user data, unbounded
containers, or entire binary buffers; record the relevant bounds, identifiers,
hashes, or selected elements instead.

## Choose a searchable log representation

Prefer a mature formatter or the logger already established by the project.
`fmt::print(stderr, ...)` is a direct default; include `<fmt/ranges.h>` when its
supported range and container formatting is useful. `SPDLOG_DEBUG(...)` is also
appropriate, but make sure the build sets `SPDLOG_ACTIVE_LEVEL` to admit debug
calls and the runtime logger level is set to `spdlog::level::debug`. The
single-header `archibate/debug-hpp` is another convenient option, not an assumed
solution for every project-specific type or non-STL container.

Whatever backend is chosen, prefix every textual probe with a stable topic key
and keep the values named:

```cpp
fmt::print(stderr, "[INSTRUMENT-QUEUE-STALL] sequence={} x={} y={}\n",
           sequence, x, y);
```

Use the same exact key for all entries belonging to that investigation so an
agent can recover the complete evidence with `rg -F` without searching through
unrelated logs. Give separate hypotheses or subsystems separate keys.

Prefer JSON Lines when nested state, schema evolution, repeated filtering, or
later aggregation makes structure more valuable than the shortest text probe:

```json
{"instrument_key":"QUEUE-STALL","sequence":42,"state":{"x":1,"y":2}}
```

Emit one complete valid JSON object per line through a JSON serializer, not by
manually interpolating escaped strings. Keep field names and types stable and
write to a dedicated file or stream when mixing JSONL with protocol or human
output would corrupt it. Query a run directly with JSON-aware tools; ingest it
into SQLite for one-shot SQL analysis, or an existing ClickHouse pipeline when
durable high-volume analysis is justified. Keep tagged text when one grep is
enough rather than introducing storage machinery for its own sake.

## Bound hot-loop instrumentation

Unconditional logging in a hot loop, callback, or high-rate event path can create
a log storm, perturb scheduling, and hide the original phenomenon. Gate it by the
suspected condition or use one of:

- state-transition or changed-value logging;
- first, last, or first-N occurrence;
- every-N occurrence;
- deterministic or probabilistic sampling; or
- counters and bounded summaries emitted after the hot phase.

Keep diagnostic buffers bounded. When performance itself is the question, avoid
formatted logging in the measured region and load `$cpp-hpc-optimization` for
profiling, tracing, counters, and benchmark validity.

## Finish the investigation

Move a discovered deterministic rule into a focused test. Remove
hypothesis-specific logs and probes, then verify the original reproduction under
its failing build configuration.
