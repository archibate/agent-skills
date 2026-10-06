# rmb-cost

Displays Pi's built-in terminal costs in RMB at a fixed rate of **1 USD = 6.7 RMB**:

- Footer session total.
- `/session` totals, per-model breakdown, cache re-billing and cache-warming economics.
- Cache-warming, compaction, branch-summary and cache-miss transcript notices.
- Codemode model-call costs and their total.

Conversion uses raw USD amounts before display rounding. Small nonzero charges
retain two significant digits; other amounts use two decimal places. Stored
usage, JSON/RPC values, notice visibility thresholds and arbitrary user/tool text
are unchanged. The HTML export's session-info total remains USD; codemode's
registered renderer also converts its cost metadata in exports.

The footer/session/notice integration patches internal render paths and loads
Pi's internal accounting helpers from its Node distribution. Codemode uses
`registerToolRenderer()`. Upstream renderer changes may require an update.

**Restart Pi once when upgrading from the old footer-only version.** Its old
prototype wrapper cannot be safely removed by `/reload`; the extension warns
when it detects that wrapper. Subsequent reloads refresh the formatter callbacks
without stacking patches and re-register the codemode renderer.

The rate is a rough constant in `format.ts`, not a live exchange-rate feed.

## Tests

With `PI_SDK_PATH` pointing to an installed Pi's `dist/index.js` (Node 22.19+):

```sh
JITI_FS_CACHE=false node --import ./tests/pi-loader.mjs --test tests/*.test.mjs
```

Tests exercise the real renderers and extension loader without opening a
terminal or making model requests.
