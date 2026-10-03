# Academic research

Read this page before searching academic papers or resolving citations. For an abstract, full paper body, or PDF extraction from a known URL, use the `$web-fetch` skill.

## Find papers

```bash
jina search --arxiv "attention mechanism" -n 10
jina search --arxiv "diffusion transformer" -n 10 --json \
  | jq -r '.results[] | "\(.title)\t\(.url)"'
jina search --ssrn "corporate governance" -n 5 --json \
  | jq -r '.results[] | "\(.ssrn_id)\t\(.title)\n  \(.snippet)"'
```

SSRN snippets include the title, abstract excerpt, date, and `ssrn_id`; they can suffice for triage. Its abstract and PDF endpoints block `jina read` and plain `curl`; use `$web-fetch` for full content and its SSRN-specific retrieval route.

## Resolve BibTeX

`jina bibtex` searches DBLP and Semantic Scholar.

```bash
jina bibtex "attention is all you need"
jina bibtex "transformer" --author Vaswani --year 2017
```
