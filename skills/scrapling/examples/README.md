# Scrapling Examples

These examples scrape [quotes.toscrape.com](https://quotes.toscrape.com) - a safe, purpose-built scraping sandbox - and demonstrate every tool available in Scrapling, from plain HTTP to full browser automation and spiders.

All examples collect **all 100 quotes across 10 pages**.

## Quick Start

Browser examples require the explicit Chromium download:

```bash
scripts/scrapling browser-install
```

Skip `browser-install` when running only the HTTP fetcher or spider examples.

## Examples

| File                     | Tool              | Type                        | Best For                              |
|--------------------------|-------------------|-----------------------------|---------------------------------------|
| `01_fetcher_session.py`  | `FetcherSession`  | Python - persistent HTTP    | APIs, fast multi-page scraping        |
| `02_dynamic_session.py`  | `DynamicSession`  | Python - browser automation | Dynamic/SPA pages                     |
| `03_stealthy_session.py` | `StealthySession` | Python - stealth browser    | Cloudflare, fingerprint bypass        |
| `04_spider.py`           | `Spider`          | Python - auto-crawling      | Multi-page crawls, full-site scraping |

## Running

**Python scripts:**

```bash
uv run --no-project --with 'scrapling[all]>=0.4.14' python examples/01_fetcher_session.py
uv run --no-project --with 'scrapling[all]>=0.4.14' python examples/02_dynamic_session.py  # Opens a visible browser
uv run --no-project --with 'scrapling[all]>=0.4.14' python examples/03_stealthy_session.py # Opens a visible stealth browser
uv run --no-project --with 'scrapling[all]>=0.4.14' python examples/04_spider.py           # Auto-crawls all pages, exports quotes.json
```

## Escalation Guide

Start with the fastest, lightest option and escalate only if needed:

```
get / FetcherSession
  └─ If JS required → fetch / DynamicSession
       └─ If blocked → stealthy-fetch / StealthySession
            └─ If multi-page → Spider
```
