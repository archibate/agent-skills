---
name: web-fetch
description: >
  Fetch page content as agent-readable markdown — articles, docs, READMEs, blogs, social posts, and academic papers. Use this skill WHENEVER you want to read text content from an URL or link. Also use when curl returns noisy, truncated, or refused results.
---

# Web Fetch

Work down this fallback ladder in order. Each step is only tried when prior steps don't apply or fail.

## Fallback ladder

1. **Raw `.md` / `.txt` / plain-text URL** → `curl -sL <url>` (already clean, no HTML to strip)
2. **Route lookup** → search `references/routes.md` with `rg` for the full hostname or its parent-domain suffixes. For an identifier, recognized platform, or requested extraction operation, search by route key (for example `RFC`, `DOI`, `MediaWiki`, `Discourse`, `WordPress`, or `Gitea/Forgejo`). Use the matching route before falling through
3. **Docs page** → try `curl -sL <url>.md`. Mintlify and other docs platforms serve clean markdown on the `.md` route — if the response is `text/markdown`, you're done; otherwise fall through
4. **Blog / newsletter / multi-post index** → try RSS first: `curl -sL <url>/feed` (also `/rss`, `/feed.xml`, `/atom.xml`, `/index.xml`). Most static-site generators and CMS platforms expose one; RSS gives you clean `<content:encoded>` or `<summary>` bodies without chrome
5. **Site that you know how to fetch elegently** → try it → append to `references/routes.md` after verified working
6. **Generic site** (articles, docs, tech blogs, unknown) → `npx defuddle parse <url> --markdown` — see `references/defuddle.md`
7. **JS-rendered page** (defuddle returns empty / skeleton-only content) → `$agent-browser` skill
8. **Cloudflare / anti-bot protection** (Turnstile, blocked responses, 403/503) → read `references/scrapling.md`
9. **Still blocked and genuinely need this page** → ask the user to open it and paste the content, or offer the `$chrome-cdp` skill (requires explicit user approval first). Otherwise, give up and report the failure.

## Bulk discovery

For whole-site ingestion, probe `<site>/llms.txt` (URL index) and `/llms-full.txt` (full corpus). Convention adopted by Mintlify, Cloudflare, Stripe, Next.js, and others. On 404, fetch the index page `<site>/` instead.

For search within site, search `references/routes.md` for the site; rows tagged `search:` expose a dedicated search API for when you have a topic, not a URL. Otherwise use the `$web-search` skill with a `site:` filter, then fetch the result URL via the fallback ladder.

## Summarized fetch

The ladder retrieves full page content in markdown without an AI summarization step. Search keywords for headline facts if the result failed to read at once. Reach for `references/summarize.md` only when you need a quick AI summary on full content.
