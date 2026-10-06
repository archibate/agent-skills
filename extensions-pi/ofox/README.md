# ofox

Discovers Ofox chat models using `$OFOX_API_KEY` (or `/login ofox`). Models appear
under `ofox`, retaining Ofox's catalog IDs, for example:

```sh
pi --list-models ofox
pi --model ofox/anthropic/claude-opus-5.5
```

Claude uses `/anthropic`, Gemini uses `/gemini/v1beta`, and other models use
advertised Responses or Chat Completions endpoints. Catalog prices are converted
from per-token to Pi's per-million-token rates. Known Pi models supplement
thinking-level metadata; the live catalog determines inventory, limits, and prices.
Image generation, video, embeddings, and transcription are not registered.

CLI startup restores cached models through Pi's main runtime before model
selection. Interactive Pi refreshes live catalogs in the background; the extension
factory does not perform discovery. `--list-models` reads the cache, even online.
With an empty cache, start Pi without an Ofox model override and let the background
refresh finish, or run `/ofox-refresh`, before selecting an Ofox model.
SDK embeddings use their own `modelRuntime.refresh({ providers: ["ofox"] })`,
respecting injected auth/storage. Catalogs are cached in Pi's `models-store.json`
for one hour; manual refresh forces an update. Refresh errors retain the last
successful catalog. `--offline` / `PI_OFFLINE` restore only cached models.
Discovery never sends prompts or makes inference requests.

Remove Ofox redirects from `models.json` and change model-cycle entries to
`ofox/<catalog-id>`. Built-in providers remain independent. Existing sessions keep
their recorded provider/model selections; select an Ofox model when resuming them.
Gemini handoffs replay foreign tool history as text with result images; native
Gemini histories retain their signed tool calls.

Tests (requires Pi on `PATH`):

```sh
node --test tests/ofox_provider_test.mjs
```
