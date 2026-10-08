# Native desktop UI

## Setup

Use `$computer-use` for private desktop setup, screenshot/input mechanics, and
owned-resource cleanup. Keep those recipes in that skill. Identify the current
build, target application/window, display scaling, client-area dimensions, theme,
and locale before testing. For graphical terminal emulators, also load
[TUI](tui.md); desktop capture does not replace PTY interaction checks.

## Exercise and capture

Capture and inspect the actual target window before input. Verify focus, then
exercise relevant keyboard and pointer transitions: selection, menus, dialogs,
validation, scrolling, and window resizing. For animated transitions, also follow
[Motion](motion.md) to capture progression, not just endpoints. Reobserve after
focus changes or modal dialogs; check the resulting state rather than relying on
input delivery.
Use screenshots from the verified session and window, following `computer-use`
for coordinate mapping and capture validity.

## Surface checks

- Check layout at intended window sizes and display scales; include minimum-size
  behavior and restored sizes where relevant.
- Inspect text/glyph fallback, scaling blur, clipped controls, scrollable content,
  and alignment. Use toolkit-native bounds/layout inspection to resolve ambiguity.
- Check keyboard focus, selected/disabled states, modal ownership, dialog placement,
  and overlays. Ensure controls remain visible and reachable after resizing.
- Verify visible hit areas match pointer targets and focus indicators survive
  themes/scaling. Account for window decorations versus client-area coordinates.
- Repair layout constraints, intrinsic sizing, or toolkit layouts at their owner;
  avoid compensating for a scaling/layout bug with fixed click coordinates.

## Completion evidence

Reinspect final windows and relevant dialogs across the agreed size/state matrix.
Report application/window identity, tested scaling and dimensions, transitions,
and screenshot evidence. Logs or accessibility trees support diagnosis but do not
establish appearance. Finish with the owned-session cleanup in `computer-use`.
