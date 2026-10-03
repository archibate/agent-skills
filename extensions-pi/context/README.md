# context

`/context` visualizes how the model's context window is being used. It breaks the
next request into the categories Claude Code's `/context` shows: system prompt,
project context files, skills, tool definitions, MCP tools, conversation
messages, and summaries — plus free space.

## Usage

```text
/context          show the breakdown
/context tools    include the per-tool detail
/context skills   include the per-skill detail
/context all      include both
```

The overlay scrolls with arrows, PageUp/PageDown, Home, and End, and closes with
Esc, Enter, q, or Ctrl+C.

## Counting

- The window total is authoritative: it comes from the provider's reported usage
  via `ctx.getContextUsage()`.
- Per-category counts use pi's own chars/4 estimate (`estimateTokens`), then are
  scaled so they sum to the reported total. Providers report a single token count
  per request, so the system/files/skills/tools/messages split cannot come from
  the transcript and is necessarily approximate.
