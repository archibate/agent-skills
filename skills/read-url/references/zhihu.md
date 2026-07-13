# Zhihu

Use for any `zhihu.com` / `zhuanlan.zhihu.com` article — the one "Hard" site where plain `curl`, `defuddle`, and `/scrapling` all fail.

## Why the generic tools fail

Zhihu serves anonymous `curl` a bot-challenge page, and 403s its JSON API on any non-browser TLS fingerprint. The `d_c0` device cookie that unlocks content is only issued to a real browser that runs the homepage JS challenge — so `curl` (no JS) and `/scrapling`'s stealthy-fetch (fetches the target URL directly, no warmup) both land on the challenge. The API also rejects browser-acquired cookies passed via `requests`/`curl` — it checks the TLS + `x-zse-*` signature fingerprint too.

## Usage

```bash
scripts/fetch_zhihu.py <article-url>
```

The script's shebang uses `uv run --script` with PEP 723 inline deps (`playwright`, `markdownify`), fetched into an ephemeral env on first run — no pollution of the user's global Python. It reuses an already-downloaded Chromium if one exists (Playwright cache, `/usr/bin/chromium`); otherwise Playwright downloads it once.

It launches a headless Chromium with anti-detection tweaks, warms up on the zhihu homepage to earn `d_c0`, then extracts the article from the embedded `js-initialData` payload and prints clean markdown to stdout. No login, no cookie file.

## Limits

Public articles and answers only. Login-gated content — collections (收藏夹), paywalled pieces, anything showing "登录后查看" — returns empty; escalate to `/chrome-cdp` with the user's logged-in session.
