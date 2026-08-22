# CLI operations

Read this page when installing or configuring the CLI, composing commands, batching work, parsing structured output, or diagnosing failures.

## Setup

Skip installation if `command -v jina` returns a path. Otherwise install once:

```bash
uv tool install jina-cli --with 'httpx[socks]'
```

Set `JINA_API_KEY` in the environment. Get a key at <https://jina.ai/?sui=apikey>. Most subcommands also accept `--api-key` to override the environment value.

## Pipes and batches

Commands read stdin and write stdout, so compose them with Unix pipes:

```bash
# Search and rerank
jina search "transformer models" | jina rerank "efficient inference"

# Read multiple URLs, one per line
cat urls.txt | jina read

# Search, then deduplicate near-identical results
jina search "attention mechanism" | jina dedup

# Expand a query, then search the first variant
jina expand "climate change" | head -1 | xargs -I {} jina search "{}"

# Request JSON and slice it with jq
jina search --arxiv "BERT" --json | jq -r '.results[].title'
```

For batch fan-out where a subcommand takes one input, such as `search` or `bibtex`, launch parallel Bash calls or use `xargs -P`:

```bash
printf '%s\n' "query A" "query B" "query C" | xargs -P 3 -I {} jina search "{}" --json
```

Fan one query into five diverse parallel searches with:

```bash
jina expand "LLM" | xargs -P 5 -I {} jina search "{}"
```

## Structured output and failures

Use `--json` on data-returning subcommands when parsing output. Default text is for humans and Unix pipes. Errors go to stderr with a fix hint; inspect the exit status instead of parsing stderr.

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | User or input error: missing arguments, bad input, or missing API key |
| 2 | API or server error: network, timeout, or HTTP error |
| 130 | Interrupted with Ctrl+C |

```bash
jina search "query" && echo "ok" || echo "failed: $?"
```

## Session context

Run `jina primer` to print session context such as time, location, and network.
