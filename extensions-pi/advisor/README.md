# advisor

A parameterless `advisor()` tool for Pi. The main model gathers evidence and executes;
a separate, tool-free model reviews its interpretation, approach, or completed work.
Loading the extension does not start a model request. The main model decides when to consult.

## Use

Disabled unless the selected main model has a pairing or you supply an override:

```sh
pi -e ./extensions-pi/advisor                         # follow pairings; missing file means off
pi -e ./extensions-pi/advisor --advisor provider/model # override for this process
pi -e ./extensions-pi/advisor --advisor none           # disable despite pairings
```

Load the selected advisor's provider and configure its credentials/catalog. For Ofox,
load the [Ofox extension](../ofox/README.md) too. Model IDs must be exact, not fuzzy matches.

### Pairings

Optional user-level file: `~/.pi/agent/advisor.json`, or
`$PI_CODING_AGENT_DIR/advisor.json` when that directory is configured. Example:

```json
{
  "pairings": {
    "ofox/openai/gpt-6-luna": "ofox/anthropic/claude-opus-5.5",
    "ofox/anthropic/claude-opus-5.5": null
  }
}
```

No file is created automatically. An absent main-model entry, `null`, or an empty map
means no advisor: the tool is hidden and cannot be activated by tool search.
Pairings follow the resolved selected main model, whether chosen through `--model`,
`/model`, scoped cycling, startup defaults, or session resume. A virtual main model
uses its selected identity, not its per-request physical route.

Precedence: **`--advisor` override → exact main-model pairing → off**. An override
stays fixed across main-model changes and does not persist into a new process.
Pi's tool restrictions (`--no-tools`, `--tools`, `--exclude-tools`) still apply.

Configuration is read at session initialization and `/reload`, not watched. Invalid
configuration reports an error and disables the tool until reloaded; an explicit CLI
override bypasses the file. Project-local pairings are not read. The JSON file must
contain only a `pairings` object and fit within 1 MiB.

SDK hosts with a custom `agentDir` should inject the same directory via
`extensionFactories: [(pi) => advisor(pi, agentDir)]`; Pi's public `getAgentDir()`
accessor only knows the environment/default directory, not the SDK option.

### Consultation options

Ask the main model to consult after reading relevant files or sources, before committing
to a consequential approach, when stuck, or after collecting verification results.
The advisor can identify missing evidence but cannot fetch it. There is no automatic
“every N turns” policy or enforced consultation schedule.

| Flag | Default | Meaning |
|---|---|---|
| `--advisor` | Follow pairings | Required value: exact `provider/model` or `none`; replaces `--advisor-model` |
| `--advisor-thinking` | `high` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; must be supported by the model |
| `--advisor-max-tokens` | `8192` | Total output limit including thinking, where supported by the provider API |
| `--advisor-cache` | `short` | `none`, `short`, `long`; Anthropic uses 5m or 1h |
| `--advisor-timeout` | `180` | Deadline in seconds, from 1 to 1800 |

Flags apply to this Pi process; no global settings or credentials are written. Model
selection is exact: missing models/authentication and unsupported effort fail explicitly,
without enabling Pi's inherited server-side fallback policy. Any distinct provider-reported
response model is displayed. Virtual routers are rejected because they resolve the physical
model after these safeguards are applied. Configure effort/limit defaults in your launch command.

## Context contract

The request has independent reviewer instructions and one native user message containing
labeled transcript blocks. Each historical message is a separate text block; images split
that message into text/image blocks in their original order. There is no native-role replay,
JSONL session dump, base64-in-text image, or forked agent loop.

Included:

- Current effective main-agent instructions.
- Active branch's retained user/assistant messages, tool arguments and results, and native images.
- Compaction/branch summaries, labeled as summaries rather than original evidence.
- Prior advisor calls and visible advice as quoted tool history, not the reviewer's own assistant turns.

Excluded: private thinking and signatures, transport/usage metadata, tool-result `details`,
abandoned branches, compacted-away originals, and context-edited omissions. The current
instructions replace historical system-prompt patches; tool schemas are not separately copied.
The snapshot uses Pi's persisted context projection, not transient modifications made by
other extensions' request-only `context` hooks.

This sends the retained context to the selected provider, which may differ from the main
model's provider. The main agent must gather files, sources, and test evidence first.
Only visible advisor text returns; its private thinking is discarded. No tool is exposed or
executed, even if the advisor unexpectedly returns a tool call.

The extension refuses unsupported/missing images, unknown message roles, and transcripts
over 32 MiB or 10,000 messages rather than silently dropping evidence. Provider context and
image limits still apply. Compact the main conversation or select an appropriate model on overflow.

## Caching and cost

On Anthropic Messages, the extension marks the reviewer system prompt, the previous
successful transcript endpoint when its prefix still matches, and the new endpoint. Existing
blocks stay unchanged; retaining the previous marker avoids the 20-block lookback limit.
Compaction, edits, instruction/model/effort changes, or branch changes may invalidate the
transcript prefix. Reloading loses local endpoint tracking. Other APIs use their native caching.

Cache hits depend on TTL, minimum prompt size, provider routing, and gateway behavior. The
result reports actual provider input/output, cache-read/write tokens, and catalog-estimated
USD cost; nested usage contributes to Pi's session totals. These figures are not a provider invoice.

There is one inference per consultation, no internal retry or tool loop, and no automatic fallback.
The output limit includes thinking; a truncated response is marked incomplete. Manual-thinking
Anthropic models require at least 2048 output tokens. Pi's Codex
subscription adapter does not transmit output-token caps; on that route the deadline still
applies, but `--advisor-max-tokens` is not a hard provider limit. Other adapters must also honor
their advertised options. A deadline or transport failure can still incur charges, and usage
may be unavailable when the provider does not return a final response. Cancellation allows
up to 500ms for final usage, then returns the already-observed usage marked incomplete. A
broken adapter's later usage is not retroactively added to a persisted tool result.

## Tests

Node 22.19+ and an installed Pi are required. Tests resolve the installed host's dependencies
into an isolated temporary workspace; they do not install packages into this checkout.
`PI_SDK_PATH` can override discovery with the host's `dist/index.js` path.

```sh
JITI_FS_CACHE=false PI_OFFLINE=1 node --test extensions-pi/advisor/tests/*.test.mjs
```

Live E2E is opt-in, uses only cached Ofox `openai/gpt-6-luna` metadata and `$OFOX_API_KEY`,
sends synthetic text/image fixtures, and keeps settings, credentials, and sessions in memory
or a private workspace. It bounds requests, output, and duration; no user tools or files are used:

```sh
PI_ADVISOR_LIVE=1 JITI_FS_CACHE=false PI_OFFLINE=1 \
  node --test extensions-pi/advisor/tests/live.test.mjs
```

`PI_ADVISOR_LIVE_CATALOG` can point to another `models-store.json`. This checks plumbing,
not advice quality, Opus inference, or real Anthropic cache hit rates.
