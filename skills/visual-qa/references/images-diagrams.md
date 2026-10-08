# Images, charts, and diagrams

## Setup

Identify the source facts, intended labels and relationships, output dimensions,
and viewing scale. For generated images, use the prompt and supplied data as the
content contract; visual plausibility is not factual correctness. Combine this
route with web, desktop, or documents when the image has a hosting surface.

## Render and inspect

Open the final raster output or render vector content with the target renderer.
Inspect the full composition at its intended scale and zoom into suspicious
regions. For an embedded image/diagram, inspect both the asset and its final
placement: cropping, scaling, and host layout can change the visible result.

## Surface checks and repairs

- Compare exact text, numbers/arithmetic, counts, ordering, labels, color semantics,
  spatial relationships, omissions, and invented details against the source.
  Validate engineering structure independently of how convincing it looks.
- Declare each connector's intended source, target, and direction. Check both
  anchors; arrowheads should reach the target boundary without obscuring content.
  Coincident centers do not establish that a line connects the right objects.
- Check joined segments for gaps/doubled strokes, repeated shapes for consistent
  dimensions, and containers for intended padding. Distinguish measured centering
  from optical balance; judge tolerance at the intended scale and stroke width.
- Inspect thin strokes, raster density, antialiasing, glyphs, label collisions,
  clipping, contrast, and legibility. Check coordinate-based primitives at every
  relevant size and embedding scale.
- Derive coordinates from data, anchors, or rendered bounds; use graph/connector
  layout tools for nontrivial routing. Fixed coordinates are appropriate for
  stable plots and deliberate artwork, but fragile when duplicating host layout.
- For generated raster content, make a targeted edit or regenerate, then recheck
  every visible fact. Prefer code-native geometry when exact editability, machine
  readability, reproducibility, accessibility, or data binding is required.

## Completion evidence

Inspect the final edited/regenerated output and its host placement when relevant.
Keep full-view and focused captures or geometry measurements. Report which source
facts and target scales were verified and any unresolved content or rendering gap.
