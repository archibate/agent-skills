# AI Summarized Fetch

Use this strategy only when you only need a summarized conculsion from a lengthy page (or tons of pages) that is noisy to read or search.

1. **Claude Code / Codex (with their official model)** → use the built-in `WebFetch` tool. This invokes a remote small model on Anthropic / OpenAI server side to summarize a content. Due to lack of ladder, may return refused results. Cost: almost free. Decision: use it to save main context tokens when full content is not necessary.
2. **Third-party harness without a built-in `web_fetch`** → use the ladder described in this skill to save result markdown file(s) into a scratchpad, then spawn a subagent (use fork, or a fresh subagent with a cheap model if configurable, to save cost). Cost: additional API tokens. Decision: use only when the content is really noisy and ungreppable, prefer `grep`/`rg` whenever it can already work.
