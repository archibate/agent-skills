# cache-compact

Makes Pi's compaction reuse the conversation's prompt cache.

Pi's default summarizer sends the conversation as one new text prompt with a
different system prompt and no tools, so it never reads the cache: the history
is paid again as fresh input (or as a cache write, 1.25× on Anthropic). This
extension summarizes in a fork of the session instead, like `/btw`: an in-memory
session seeded with the whole branch, with the same session id, model, thinking
level, tools and (reloaded) extensions. Its request is exactly the main
session's next request, the conversation plus one user message asking for Pi's
structured summary, so the history is read from cache (0.1× or less on Anthropic,
OpenAI and DeepSeek) and only the new tail is paid at full price.

Measured on a 17k-token session with tools:

| Model | Cache read | Uncached | Compaction cost |
|---|---|---|---|
| `koozhan/claude-opus-5-5` | 17,269 | 460 | $0.0044 (Pi's default ≈ $0.02) |
| `koozhan/claude-opus-5-5`, resumed session | 17,272 | 461 | $0.0048 |
| `koozhan/gpt-6.1-sol` | 14,284 | 2,046 | $0.0011 |
| `ofox/deepseek/deepseek-v4.1-flash` | 12,032 | 371 | $0.0007 |

## Behavior

- Every compaction uses the fork, whatever the cache state: the summary does not
  depend on timing. A cold cache costs a full prompt (about 2× Pi's default,
  which drops recent messages, truncates tool results and omits thinking) and
  shows an info notice with the cache-read count.
- The summary uses Pi's format, covers the whole visible conversation (including
  messages Pi keeps verbatim), and gets Pi's `<read-files>`/`<modified-files>`
  lists. `/compact <focus>` instructions are passed on.
- The fork declares the session's tools (they are part of the cached prefix) but
  blocks every tool call, and has compaction and cache warming off. Nothing is
  written to the main session except the compaction entry; its usage is recorded
  there.
- Works for every API and after a resume, since the fork is rebuilt from the
  session.

Pi's default compaction runs instead when:

- compaction recovers from a context overflow (the conversation no longer fits);
- the fork fails, is cut off, calls a tool or returns no text. These show a
  warning; the failed attempt's cost is not recorded.

## Limits

- Summaries come from the conversation's own model; no cheaper summarizer.
- Each compaction reloads the session's extensions in the fork (a few hundred ms).
  Extensions given only on the command line are not reloaded, and extension state
  that shapes the system prompt starts fresh; either can cost a cache miss.
- As with `/btw`, disposing the fork also closes provider connections keyed by
  the session id (currently only OpenAI Codex websockets).
- Pi does not carry file lists forward from extension compactions, so a later
  compaction lists only files from its own range.

Tests (requires Pi on `PATH`):

```sh
node --test tests/cache_compact_test.mjs
```
