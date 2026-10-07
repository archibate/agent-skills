# subagent-cost

Adds registered subagents' recorded USD costs to Pi's footer. `/session` shows
Parent, Subagents and Total; token counts and per-model details remain parent-only.
With [rmb-cost](../rmb-cost), all three cost fields use its RMB formatter.

Install this extension in both parent and child Pi processes, alongside the updated
[jobs](../jobs) extension. Reload the parent before launching children. `job_start`
passes `PI_SUBAGENT_PARENT_SESSION_FILE`; children register themselves without
parsing commands or relying on session-ID naming. Plain shell jobs do nothing.

## Accounting

A non-context registration entry marks the start of a child's own accounting.
Earlier entries—including copied fork history—are excluded. The marker is scoped
to the child's session file, so copied markers cannot register another fork.
Resuming the child restores the original parent and baseline even without the
environment variable. There is no historical backfill.

Assistant, tool-result, compaction, branch-summary and arbitrary usage entries
(including cache warming) count, regardless of success, failure or cancellation.
Only usage Pi records can count; provider charges missing from Pi cannot be inferred.
Stored core usage and JSON/RPC totals are not modified.

Each child atomically replaces one small cumulative-USD snapshot in
`<parent-session-file>.subagent-cost/`. The directory is private (0700), records
are 0600, and filenames hash the child's session path. No transcripts or secrets
are copied. Keep this directory beside its session to retain totals on reopening.

The parent watches that directory, reads changed snapshots, and coalesces renders
for 50 ms. There are **no periodic scans or idle timers**. Startup, `/session`, and
the next user turn reconcile snapshots to recover missed notifications; watch
errors surface a warning and are retried on reconciliation. Duplicate notifications
do not add costs twice. Invalid records retain the last valid in-memory total.

## Scope and recovery

- Intended for local filesystems and one writer per Pi session, like Pi's own
  session files. Direct children count; recursive subagent orchestration is not
  supported. `--no-session` cannot provide persistent attribution.
- Child publication works while the parent is absent. Costs remain after the
  child exits; shutdown/reload closes watchers and restores the append adapter.
- A hard kill between Pi's transcript write and snapshot publication can leave
  the last charge stale until the child resumes. Snapshots are atomically replaced,
  not fsynced; this is not a power-loss-proof billing ledger.
- Storage/watch errors warn once per session and never fail a successfully
  persisted agent turn. Fix the reported problem and `/reload`.
- Pi **1.0.4** is supported. There is no public extension event for every recorded
  charge, so a guarded per-instance `_appendEntry` adapter publishes after Pi's
  synchronous append succeeds. Footer statistics and `/session` rendering use
  reload-safe internal adapters too. Review these adapters before upgrading Pi.

Memory is O(registered children), with a bounded pending-event queue. Normal
updates read only the changed small records; startup/reconciliation reads this
parent's records, never every session. Child startup scans its already-loaded
history once; subsequent accounting is O(1) per appended entry.

## Tests

From the repository root, with `PI_SDK_PATH` pointing to Pi 1.0.4's `dist/index.js`
and `PI_SCRATCHPAD_DIR` pointing to a private test workspace:

```sh
JITI_FS_CACHE=false node --import ./extensions-pi/rmb-cost/tests/pi-loader.mjs \
  --test extensions-pi/subagent-cost/tests/*.test.mjs
COST_LOAD_ORDER=rmb-first JITI_FS_CACHE=false node \
  --import ./extensions-pi/rmb-cost/tests/pi-loader.mjs \
  --test extensions-pi/subagent-cost/tests/presentation.test.mjs
```

Tests use real Pi session persistence/renderers and private child processes with
synthetic usage. They make no model requests and open no terminal or shared service.
