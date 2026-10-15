# session-time

Shows the agent's working time in Pi, split into API inference and tools:

- Footer status line: `⏱ 12m 34s` session total, then the current run
  `· ▶ running 42s` live (`· ⏸ waiting 42s` in `warning` color while a dialog is
  open), or the last finished run `· ■ ran 9s`. Hidden until the first run.
- `/session`: a `Time` section with working time and run count, then the current
  or last run; each has indented API inference (requests), Tools (calls) and
  Other sub-items.

## Accounting

A run spans the first `before_agent_start`/`agent_start` to `agent_settled`, so
retries, post-turn auto-compaction and queued continuations count (compaction
before a prompt runs ahead of `before_agent_start` and is not counted).
Blocking extension UI prompts (`ui_prompt_start`/`ui_prompt_end`: questions,
approvals, sandbox prompts) pause it; typing the next prompt is idle time.

Within a run, time goes to one phase:

- **Tools** while any tool runs (`tool_execution_start`/`_end`). Parallel and
  nested calls are a union, not a sum; only top-level calls are counted.
- **API inference** from `before_provider_request` to the assistant
  `message_end`: time to first token plus streaming. Provider retries inside one
  request count once. Only requests after `turn_start` count; cache-warming
  requests, which fire the same hook with no `message_end`, are ignored.
- **Other**: the rest, e.g. extension hooks, context transforms, auto-compaction
  and its summary requests, and retry backoff.

Each settled run appends a non-context custom entry
`session-time {v: 1, activeMs, apiMs, toolMs, requests, toolCalls, aborted?}`;
a run interrupted by shutdown or `/reload` is saved with `partial: true`. Totals sum these entries across the
whole session file, like Pi's cost totals; forks inherit copied history.
**There is no backfill**: runs before installation have no reliable boundaries.

The footer uses the public `ctx.ui.setStatus()`. A 1 s ticker runs only during
runs in TUI mode; other modes persist entries without status updates.

## Pi internals

`/session` has no extension hook, so `InteractiveMode.handleSessionCommand` is
wrapped with the same reload-safe dispatch as [subagent-cost](../subagent-cost),
exposing `Symbol.for("pi.cost.base-method")` so [rmb-cost](../rmb-cost) still finds
its own wrapper. The section is inserted before `Tokens` and reuses Pi's header
and label styles. Upstream renderer changes may require an update.

## Tests

With `PI_SDK_PATH` pointing to an installed Pi's `dist/index.js` (Node 22.19+),
from `extensions-pi/`:

```sh
JITI_FS_CACHE=false node --import ./rmb-cost/tests/pi-loader.mjs \
  --test session-time/tests/*.test.mjs
TIME_LOAD_ORDER=cost-first JITI_FS_CACHE=false node \
  --import ./rmb-cost/tests/pi-loader.mjs --test session-time/tests/*.test.mjs
```

Tests use a fake clock, real `SessionManager` and the real `/session` renderer
composed with rmb-cost and subagent-cost, plus one real agent loop with Pi's faux
provider in a temp directory. No terminal or network requests.
