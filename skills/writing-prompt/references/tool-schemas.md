# Agent-facing Tool Schemas

Treat the tool description and JSON Schema as one interface. Put each fact at the narrowest scope where it helps the agent choose or use the tool.

## Put information where it belongs

| Surface | What belongs here |
|---|---|
| Tool description | Purpose, material side effects, and normal follow-up actions. |
| Variant description | What that mode selects or creates, and behavior specific to that mode. |
| Property description | Meaning, units, interpretation, and how to discover valid values. |
| Schema structure | Types, enum values, required fields, allowed combinations, and bounds. |
| Runtime result | Diagnostics and next steps specific to the actual outcome. |

Let the schema express structural constraints. Remove prose that merely restates its enum choices, required fields, or ranges. Describe material behavior that affects the call, such as cancelling pending work, invalidating a frame, or preserving a resource across switches.

Moving a paragraph into a field description improves placement; removing its duplicate reduces prompt size. Repeat a critical instruction only when the consuming client omits the relevant schema description or observed behavior justifies it.

## Make choices explicit

When modes have different parameters, prefer an explicit discriminator with fields scoped to each variant. For example:

- `{"type":"private"}`
- `{"type":"default"}`
- `{"type":"named","name":"work"}`

The schema can express that only `named` accepts and requires `name`. A free-form string with special values would require the agent to learn that distinction from prose. Once routing separates the modes, names such as `private` and `default` need no reservation for that distinction; retain independent constraints such as path safety.

Use constructs supported by the actual client and schema generator. Check the schema exposed to the agent, not just the source types.

## Example: computer_connect

Tool description:

> Connect to a desktop. Every valid connection attempt cancels pending waits and invalidates previous frames; call computer_observe afterward.

Place the remaining information with its target:

- `Private` variant: creates or reuses this MCP process's offscreen desktop; switching away preserves it until the MCP exits.
- `Default` variant: connects to the existing default daemon.
- `Named.name`: instance-name semantics, the command for finding candidate names, and the fact that candidate directories may be stale.

The tool description no longer needs to list the three types or explain when `name` is required. Discovery guidance remains available where the agent chooses a name.

## Reveal recovery through results

For the shared rule, read [Tool, script, and CLI results](progressive-disclosure.md#tool-script-and-cli-results) before designing result messages.

Keep valid input choices explicit in the schema. For output diagnostics, a stable `code` plus an actionable `message` usually suffices; keep internal error enums internal unless consumers require a closed output enum. Moving an error-and-remedy catalog from the tool description into field descriptions still exposes it before any failure occurs.

## Verify the published contract

Inspect the actual tool listing, including generated descriptions and schema branches. Check that constraints and behavior agree with runtime validation; schema annotations alone do not establish enforcement. For a prose-only change, verify the published text and preserve the existing behavior without adding tests that merely freeze wording.
