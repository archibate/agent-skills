# context

`/context` shows estimated context usage: system prompt, context files, skills,
tool definitions (including MCP), messages, and free space. Messages expand into
User, Assistant (Reasoning, Text, Tool calls), Tool results, Images, Other, and
Summaries. Empty categories are omitted. Overview percentages use the context window size.

## Usage

```text
/context          overview breakdown
/context tools    all call/result tool names and tool-definition detail
/context skills   also include per-skill detail
/context all      include both (aliases: verbose, -v)
```

With `tools` or `all`, Tool calls and Tool results have separate detail sections
below the existing file/skill/tool-definition details. Each lists all tool names,
ranked independently by token footprint, with ties ordered by name. Headers count
distinct names, not calls. The default view shows only their overview totals.

The overlay scrolls with arrows, PageUp/PageDown, Home, and End, and closes with
Esc, Enter, q, or Ctrl+C. Non-TUI output uses the same breakdown.

## Counting

- The used total comes from `ctx.getContextUsage()`: Pi may combine provider usage
  with estimates, and usage can be unknown immediately after compaction. When
  unknown, the report uses raw estimates.
- Categories use Pi's chars/4 estimator (`estimateTokens`), including its image
  estimate, scaled with integer allocation so rows sum to the used total and
  children sum to their parent. Per-tool detail reconciles with its overview row.
  File, skill, and tool-definition details retain their separate raw estimates.
- This is an approximate breakdown of retained context, not exact provider
  tokenization or lifetime generation usage. Active branches, compaction, and
  context edits determine which messages count.
- Reasoning counts only recorded thinking text, not hidden/encrypted reasoning,
  signatures, or reasoning usage counters. Calls count names and JSON arguments;
  results count non-image content, including failures. Images from user messages,
  tool results, and custom messages count only in Images, using Pi's fixed estimate
  (currently 1,200 tokens each before scaling), not model-specific image sizing.
  Result metadata and nested execution records do not add context. Historical and
  qualified tool names are preserved even when the tool is no longer active.
