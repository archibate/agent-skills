# MediaWiki

Any site running MediaWiki — Wikipedia, Fandom, Arch Wiki, cppreference, game wikis, and many docs sites. The API shape depends on whether the install is run by Wikimedia Foundation (gets extra endpoints) or third-party (vanilla MediaWiki).

## Wikimedia-run (Wikipedia / Wiktionary / Wikiquote / Wikibooks / etc.)

Has the REST API + the TextExtracts extension — gives the cleanest output:

```bash
# Short summary
curl -sL 'https://<lang>.wikipedia.org/api/rest_v1/page/summary/<title>' | jq

# Clean rendered HTML (no chrome)
curl -sL 'https://<lang>.wikipedia.org/api/rest_v1/page/html/<title>'

# Full plaintext extract via TextExtracts
curl -sL 'https://<lang>.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&titles=<title>&format=json' | jq -r '.query.pages | to_entries[0].value.extract'
```

## Third-party MediaWiki installs

The REST API and TextExtracts aren't installed. Fall through these in order:

1. **Try `?action=raw` appended to the article URL** — works on many installs (Arch Wiki, cppreference, OSRS wiki, UESP, `*.wiki.gg`):

   ```bash
   curl -sL 'https://en.cppreference.com/w/cpp/container/vector?action=raw'
   curl -sL 'https://wiki.archlinux.org/index.php?title=Systemd&action=raw'
   ```

2. **If empty, use `api.php?action=parse`** — some installs (notably `minecraft.wiki`) return 200-empty on `?action=raw`:

   ```bash
   curl -sL '<wiki>/api.php?action=parse&page=<Page>&prop=wikitext&format=json' | jq -r '.parse.wikitext."*"'
   ```

   Swap `prop=wikitext` for `prop=text` to get rendered HTML instead.

3. **If the wikitext is template-heavy** (cppreference especially — `{{dcl}}`, `{{cpp/title}}`, etc. without template expansion look cryptic), fall back to `defuddle` on the rendered page. The rendered HTML has templates expanded:

   ```bash
   npx defuddle parse 'https://en.cppreference.com/w/cpp/container/vector' --markdown
   ```

## Searching (don't guess URLs)

MediaWiki exposes a search API at `api.php` — no need to fabricate a page URL and hope. Two endpoints:

```bash
# Title-prefix autocomplete (the search-box "did you mean" suggestions)
curl -sL '<wiki>/api.php?action=opensearch&search=<q>&limit=10&format=json' | jq -c '.[1]'

# Full-text ranked search with snippets
curl -sL '<wiki>/api.php?action=query&list=search&srsearch=<q>&srprop=snippet&srlimit=5&format=json' \
  | jq -r '.query.search[] | "\(.title)  —  \(.snippet | gsub("<[^>]*>"; ""))"'
```

`opensearch` covers prefix and typo-style matches; `list=search` ranks pages by relevance and returns snippets, so loose phrases resolve correctly (e.g. `blue baby` → the `???` character on the Isaac wiki). Both work on Wikimedia-run and third-party installs.

**Practical loop for any MediaWiki site**: search first → pick the canonical title from the results → fetch it via step 1 (`?action=raw`) or step 2 (`api.php?action=parse`). No fabricated URLs, no 404s.

## Notable wikis

Covered by this reference — the URL/API patterns are all the same, just vary in which step (1 / 2 / 3) works best:

- **Fandom: `*.fandom.com`** — **Cloudflare-protected**, plain `curl` returns the "Just a moment..." challenge. Use `$scrapling` skill instead. Still MediaWiki under the hood, but this reference's paths don't apply.
- Game wikis on `*.wiki.gg` (Terraria, Minecraft Legacy, many others migrated off Fandom) — step 1
- Minecraft Wiki: `minecraft.wiki` — step 2 (api.php) needed
- Pokémon: `bulbapedia.bulbagarden.net` — step 1
- Elder Scrolls: `en.uesp.net` — step 1
- OSRS: `oldschool.runescape.wiki` — step 1
- C++: `en.cppreference.com` — step 3 (defuddle) preferred due to templates
- Wikitech: `wikitech.wikimedia.org` — step 1 (vanilla MediaWiki despite the .wikimedia.org domain)

## What NOT to use

- `prop=extracts` on third-party wikis — the TextExtracts extension isn't installed, returns `null`
- `/api/rest_v1/page/summary/` on third-party wikis — returns 403
