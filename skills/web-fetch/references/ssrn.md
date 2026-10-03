# SSRN retrieval

Read this page before retrieving an SSRN abstract or PDF body. For paper discovery, use the `$web-search` skill.

SSRN sits behind a Cloudflare bot challenge. `jina read` and plain `curl` return 403 on both abstract pages (`papers.cfm?abstract_id=…`) and PDF endpoints (`Delivery.cfm`). Use this escalation ladder:

1. If full content is unnecessary, use the `$web-search` skill's `jina search --ssrn` snippets. Each JSON result includes the title, abstract excerpt, date, and `ssrn_id`; this is often enough for triage and citation scaffolding.
2. Read `references/scrapling.md` and use `scripts/scrapling` on the abstract page. `extract stealthy-fetch --solve-cloudflare --ai-targeted` returns the full abstract, authors, citation block, and resolved PDF download URL as markdown.
3. For PDF body text, use a Python `StealthySession` to visit the abstract page first, reuse its cookies to download the PDF, and feed the bytes to the `$pdf` skill. The Scrapling CLI's `stealthy-fetch` does not succeed on `Delivery.cfm` because its Cloudflare DOM solver expects HTML rather than a binary PDF.
4. For citations alone, use the `$web-search` skill's `jina bibtex "<title>"` route independently of SSRN.

```bash
# Tier 2: abstract page through Scrapling
scripts/scrapling extract stealthy-fetch \
  "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=<SSRN_ID>" \
  /tmp/ssrn.md --solve-cloudflare --timeout 60000 --ai-targeted
```
