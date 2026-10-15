# cache-compact

Makes Pi's compaction reuse the conversation's prompt cache.

Pi's default summarizer sends the conversation as one new text prompt with a
different system prompt and no tools, so it never reads the cache: the whole
history is paid again as fresh input (or as a cache write, 1.25× on Anthropic).
This extension instead resends the last real request unchanged (same tools,
system prompt, messages and settings), appends the reply and anything added
since, and adds one user message asking for Pi's structured summary. The
history is read from cache (0.1× on Anthropic and OpenAI); only the new tail is
paid at full price.

Measured through Koozhan on a 15k-token session (`claude-opus-5-5`): 15,474
tokens read from cache, 474 written, $0.0046, against about $0.02 for Pi's
default.

## Behavior

- `before_provider_request` keeps a copy of each agent request. Pi's cache
  warming replays (one-token output cap) only refresh its age.
- `session_before_compact` builds the summary request with Pi's own adapter and
  splices its messages onto the copy, dropping cache breakpoints from the tail
  so the request stays within Anthropic's limit of four.
- The summary uses Pi's format, covers the whole visible conversation (including
  messages Pi keeps verbatim), and gets Pi's `<read-files>`/`<modified-files>`
  lists. `/compact <focus>` instructions are passed on.
- The model sees its tools but is told not to call them; tool definitions must
  stay to keep the cached prefix.

Pi's default compaction runs instead when:

- compaction recovers from a context overflow (the copy no longer fits);
- the copy is older than 90% of the model's cache lifetime (`promptCache`,
  `PI_CACHE_RETENTION=long` aware; 5 minutes when undeclared);
- the model, session or branch changed, or a later entry changed the model,
  thinking level or earlier context;
- the API is not Anthropic Messages or OpenAI Responses;
- the request fails, is cut off, calls a tool or returns no text. These show a
  warning; the failed request's cost is not recorded.

## Limits

- Summaries come from the conversation's own model; no cheaper summarizer.
- Pi does not carry file lists forward from extension compactions, so a later
  compaction lists only files from its own range.
- Another extension that edits requests after this one captures them only causes
  a cache miss.
- OpenCode's session headers are not replayed.

Tests (requires Pi on `PATH`):

```sh
node --test tests/cache_compact_test.mjs
```
