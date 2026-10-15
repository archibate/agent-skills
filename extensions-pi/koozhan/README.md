# koozhan

Discovers Koozhan chat models using `$KOOZHAN_API_KEY` (or `/login koozhan`).
Models appear under `koozhan` with Koozhan's IDs, for example:

```sh
pi --list-models koozhan
pi --model koozhan/claude-opus-5-5
```

The catalog comes from `GET /v1/relay/models`. Only selectable, available Claude
and GPT models are registered: Claude uses Anthropic Messages at
`https://api.koozhan.com`, GPT uses Responses at `https://api.koozhan.com/v1`.
DeepSeek and other families are excluded, as are time-of-use prices.

Prices are Koozhan's discounted USD rates, so Pi's cost reflects the actual bill
(Koozhan charges catalog USD × its `usd_cny_rate`, currently 7.2). Pi's built-in
models supply reasoning levels, input types, output limits and Claude
compatibility flags; models this Pi version does not know are skipped until Pi
learns them. The context window is the smaller of Koozhan's and Pi's limits.
Claude server-side fallback is disabled.

Koozhan adds a 1h cache breakpoint (2× input) to Anthropic requests without
`cache_control` and rejects every opt-out. Requests that ask for no caching, such
as compaction and branch summaries, therefore send an explicit 5m marker (1.25×)
instead. Other cache settings pass through unchanged.

Catalog refresh, caching and offline behavior match the `ofox` extension:
interactive Pi refreshes in the background, catalogs are cached in Pi's
`models-store.json` for one hour, `/koozhan-refresh` forces an update, failures
keep the last catalog, and `--offline` / `PI_OFFLINE` use only the cache.
Discovery never sends prompts.

Existing sessions keep their recorded `anthropic/...` or `openai/...` selections;
select a `koozhan/...` model when resuming them.

Tests (requires Pi on `PATH`):

```sh
node --test tests/koozhan_provider_test.mjs
```
