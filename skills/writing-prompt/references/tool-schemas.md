# Agent-facing Tool Schemas

Treat the tool description and JSON Schema as one interface. Put each fact at the narrowest scope where it helps the agent choose or use the tool.

## Put information where it belongs

| Surface | What belongs here |
|---|---|
| Tool description | Purpose, material side effects, and normal follow-up actions. |
| Property description | Meaning, units, interpretation, and how to discover valid values. |
| Schema structure | Types, enum values, required fields, allowed combinations, and bounds. |
| Runtime result | Diagnostics and next steps specific to the actual outcome. |

Let the schema express structural constraints. Remove prose that merely restates its enum choices, required fields, or ranges. Describe material behavior that affects the call, such as overwriting an existing file.

Moving a paragraph into a field description improves placement; removing its duplicate reduces prompt size. Repeat a critical instruction only when the consuming client omits the relevant schema description or observed behavior justifies it.

## Example: search_documents

- Tool description: "Search the document collection."
- `query` description: "Words or phrases to match in document titles and content."
- `limit` description: "Maximum number of matches to return."
- Schema: `query` is a required string; `limit` is an integer from 1 to 100.

The descriptions explain purpose and meaning; the schema carries types, required fields, and bounds.

## Reveal recovery through results

For the shared rule, read [Tool, script, and CLI results](progressive-disclosure.md#tool-script-and-cli-results) before designing result messages.

Keep valid input choices explicit in the schema. For output diagnostics, a stable `code` plus an actionable `message` usually suffices; keep internal error enums internal unless consumers require a closed output enum. Moving an error-and-remedy catalog from the tool description into field descriptions still exposes it before any failure occurs.

## Verify the published contract

Use constructs supported by the actual client and schema generator. Verify the published schema and the tool declaration actually presented to the model. Check that constraints and behavior agree with runtime validation; schema annotations alone do not establish enforcement. For a prose-only change, verify the published text and preserve the existing behavior without adding tests that merely freeze wording.
