# Browser UI

## Setup

Use `$agent-browser` for headless rendering and interaction. Use `$chrome-cdp`
when the task specifically requires the user's visible or authenticated Chrome
session and the user has approved it. Follow the chosen skill's tool workflow.

Define relevant viewport sizes, breakpoints, device-pixel ratios (DPRs), zoom,
themes, and locales. Open the latest build and reload or cache-bust after changes.
Wait for fonts (`document.fonts.ready`), images, hydration, asynchronous content,
and layout to settle. Inspect console/network failures that affect rendering.

## Exercise and capture

Drive the controls needed to reach the target states: keyboard focus, pointer
hover, active/selected controls, dialogs, validation, expansion, and scrolling.
Capture and actually inspect screenshots after transitions. Accessibility or DOM
snapshots help locate controls but do not replace rendered inspection.

## Surface checks and repairs

- Check responsive reflow, reading order, usable control sizes, and unintended
  horizontal scrolling or layout shifts at the relevant dimensions.
- Check focus rings, stacking, overlays, clipping, and correspondence between
  visible and interactive hit areas. Verify supported light/dark and high-contrast
  variants, not merely the default theme.
- Use `getBoundingClientRect()`, computed styles, and SVG geometry APIs to compare
  bounds, centers, baselines, padding, and anchors. Inspect actual font fallback
  for representative glyphs when needed.
- Treat overflow warnings as leads: shadows, transforms, and pseudo-elements can
  cause harmless reports, while a page without warnings can still look wrong.
- Prefer normal flow, Flexbox/Grid, intrinsic sizing, and design tokens. Derive
  decoration from its owning element with borders, backgrounds, or pseudo-elements.
- Use SVG for genuine vector geometry and canvas when retained DOM/SVG structure
  is unsuitable. For charts/connectors, also load [Images and diagrams](images-diagrams.md).
  Check transforms, scrolling, and zoom do not detach overlays from their anchors.

## Completion evidence

Reinspect the final build across the agreed viewport/state matrix. Keep screenshots
and focused geometry evidence where needed; report the dimensions and states
actually checked. Inspect print/export deliverables separately through
[Documents](documents.md). Close owned browser sessions after the pass.
