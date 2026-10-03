# Jina retrieval

Read this page when a matching route in `references/routes.md` selects Jina. Install and configure it only when using that route. Generic HTML fetching follows the fallback ladder in `SKILL.md`.

## Setup

Skip installation if `command -v jina` returns a path. Otherwise install once:

```bash
uv tool install jina-cli --with 'httpx[socks]'
```

Set `JINA_API_KEY` in the environment. Get a key at <https://jina.ai/?sui=apikey>. Most subcommands also accept `--api-key` to override the environment value.

## Read pages

```bash
jina read https://example.com
jina read https://example.com --links --images

# Read multiple URLs, one per line
cat urls.txt | jina read
```

If Jina is unreachable or returns incomplete content, continue with this skill's fallback ladder, skipping the failed route rather than retrying it.

## Read arXiv papers

Choose the URL form deliberately:

```bash
# Abstract and metadata, roughly 2 KB
jina read https://arxiv.org/abs/1706.03762

# Full paper body as markdown, roughly 40 KB for a conference paper
jina read https://arxiv.org/pdf/1706.03762 > paper.md

# Save the raw PDF
curl -L -o paper.pdf https://arxiv.org/pdf/1706.03762
```

SSRN blocks both `jina read` and plain `curl`; read `references/ssrn.md` before retrieving its abstract or PDF body.

## Extract PDF content

```bash
jina pdf https://arxiv.org/pdf/2301.12345
jina pdf 2301.12345
jina pdf https://example.com/paper.pdf --type figure,table
```

## Estimate publication date

```bash
jina datetime https://example.com/article
```

`jina datetime` guesses the publication or update date of a URL.

## Capture screenshots

```bash
jina screenshot https://example.com                    # print screenshot URL
jina screenshot https://example.com -o page.png        # save to a file
jina screenshot https://example.com --full-page -o page.jpg
```

## Output and failures

Use `--json` on data-returning subcommands when parsing output. Errors go to stderr with a fix hint; inspect the exit status: 0 success, 1 user/input error, 2 API/server error, 130 interrupted.

Jina requires outbound HTTPS; run it out of sandbox when sandbox networking blocks it. If failures persist, check <https://status.jina.ai/api/v2/status.json>.
