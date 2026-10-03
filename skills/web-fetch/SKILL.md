---
name: web-fetch
description: >
  Fetch page content and return agent-readable markdown — articles, docs, READMEs, blog/social posts, and academic papers. Use when retrieving content from a known URL. Also use when curl returns noisy HTML or WebFetch returns truncated, summarized, or refused results. Prefer this over WebFetch.
---

# Web Fetch

Work down this fallback ladder in order. Each step is only tried when prior steps don't apply or fail.

## Fallback ladder

1. **Raw `.md` / `.txt` / plain-text URL** → `curl -sL <url>` (already clean, no HTML to strip)
2. **Route lookup** → search `references/routes.md` with `rg` for the full hostname or its parent-domain suffixes. For an identifier, recognized platform, or requested extraction operation, search by route key (for example `RFC`, `DOI`, `MediaWiki`, `Discourse`, `WordPress`, or `Gitea/Forgejo`). Use the matching route before falling through
3. **Docs page** → try `curl -sL <url>.md`. Mintlify and other docs platforms serve clean markdown on the `.md` route — if the response is `text/markdown`, you're done; otherwise fall through
4. **Blog / newsletter / multi-post index** → try RSS first: `curl -sL <url>/feed` (also `/rss`, `/feed.xml`, `/atom.xml`, `/index.xml`). Most static-site generators and CMS platforms expose one; RSS gives you clean `<content:encoded>` or `<summary>` bodies without chrome
5. **Generic site** (articles, docs, tech blogs, unknown) → `npx defuddle parse <url> --markdown` — see `references/defuddle.md`
6. **JS-rendered page** (defuddle returns empty / skeleton-only content) → `$agent-browser` skill
7. **Cloudflare / anti-bot protection** (Turnstile, blocked responses, 403/503) → read `references/scrapling.md`
8. **Still blocked and genuinely need this page** → ask the user to open it and paste the content, or offer the `$chrome-cdp` skill (requires explicit user approval first). Otherwise, give up and report the failure.

## Bulk discovery

For whole-site ingestion, probe `<site>/llms.txt` (URL index) and `/llms-full.txt` (full corpus). Convention adopted by Mintlify, Cloudflare, Stripe, Next.js, and others. On 404, fetch the index page `<site>/` instead.

For search within site, search `references/routes.md` for the site; rows tagged `search:` expose a dedicated search API for when you have a topic, not a URL. Otherwise use the `$web-search` skill with a `site:` filter, then fetch the result URL via the fallback ladder.

## vs. WebFetch

This skill retrieves page content without an AI summarization step, using route-specific retrieval or local parsing. Check that the result contains the requested body; extraction can still be incomplete. WebFetch routes through a remote small model that may summarize, refuse, or truncate; reach for it only when you want an AI summary, not the content itself.

## When to bypass the ladder

- Need a **quick AI summary** → built-in WebFetch
- No specific URL yet, need to **search** → `$web-search` skill
