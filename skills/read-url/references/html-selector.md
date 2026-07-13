# HTML selector fallback

Use when `curl -sL <url>` returns full HTML but defuddle's output is partial or wrong — typically Q&A pages, multi-post threads, or any layout where defuddle's "main article" heuristic drops sibling content.

Not for JS-rendered SPAs (`curl` returns skeletal HTML) — use `/agent-browser` for those.

## Find the selector

Save the HTML and grep for distinctive class names or ids near the wanted content:

```bash
curl -sL <url> -o /tmp/page.html
rg -o "class=[\"'][^\"']*" /tmp/page.html | sed 's/class=.//' | tr ' ' '\n' | sort -u
```

Handles both double- and single-quoted `class=` attrs; one class per line.

If the user can name the selector (e.g. from browser devtools), use that directly.

## Extract

```bash
curl -sL <url> | ~/.claude/skills/read-url/scripts/html-select.py '<css selector>'
```

The script's shebang uses `uv run --script` with PEP 723 inline deps, so `beautifulsoup4` is fetched into an ephemeral env on first run — no pollution of the user's global Python.

## Still not working?

If `curl` returns HTML but selector extraction finds nothing useful, the server may be serving a different page to `curl` than a browser (anti-bot, Cloudflare challenge, user-agent sniffing). Fall back to `/scrapling`, which fetches with a real browser fingerprint.
