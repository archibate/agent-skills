---
name: web-search
description: >
  Search the web via the Jina search engine with time-window, region/language, and `site:` filters; find academic papers (arXiv/SSRN), citations, and images. Use this skill WHENEVER you need to search for solutions, verify a fact, ask for niche knowledge, look up public resources.
---

# Web Search

Use the `jina` CLI to discover sources. Load only the references required by the task. Fetch full content from result URLs with the `$web-fetch` skill.

## Task routes

| Task | Read before acting |
|---|---|
| Search by topic, date, region, language, blog, or `site:` filter; expand a query | [Web search](references/web-search.md) |
| Find arXiv or SSRN papers; resolve BibTeX | [Academic research](references/academic-research.md) |
| Search images or visually deduplicate image results | [Image operations](references/image-operations.md) |
| Embed, rerank, classify, or deduplicate search results | [Semantic operations](references/semantic-operations.md) |

## Cross-cutting routes

| Condition | Read before acting |
|---|---|
| Install or configure the CLI; compose pipes or parallel batches; parse JSON; handle exit codes; inspect session context | [CLI operations](references/cli-operations.md) |
| Jina network failure | Jina requires outbound HTTPS to `https://jina.ai`, run `jina` out of sandbox. Check `https://status.jina.ai/api/v2/status.json` if issue persists |
| A task spans multiple rows | Read each matching page and skip unrelated references |
