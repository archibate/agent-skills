# Visual QA Checklist

Apply the relevant checks to the final rendered artifact. State which checks or render-matrix dimensions are out of scope rather than silently skipping them.

## Rendering preconditions

- [ ] Open the latest build and cache-bust or reload after regeneration.
- [ ] Wait for `document.fonts.ready`, image completion, hydration, asynchronous content, and layout stabilization.
- [ ] Freeze or settle animation before still-image inspection; inspect motion separately when it is part of the design.
- [ ] Check the intended viewports, breakpoints, DPRs, zoom levels, themes, locales, content extremes, and interaction states.
- [ ] Check the console and network for missing fonts, images, styles, or runtime failures that change the rendered result.

## Geometry and connections

- [ ] Declare or infer each connector's intended source, target, and direction before judging its appearance.
- [ ] Every connector meets the correct source and target anchors at both ends; arrowheads stop at the target boundary without obscuring content.
- [ ] Joined line segments share endpoints without gaps, doubled strokes, or near-miss junctions.
- [ ] Underlines derive from the intended text or container, span the intended endpoints, sit below the glyphs, and have balanced left/right insets.
- [ ] Grids, boxes, and backgrounds contain their intended objects with symmetric or deliberately asymmetric padding.
- [ ] Repeated objects share the intended edges, centers, dimensions, gaps, stroke widths, and corner radii.
- [ ] Mathematical centering is measured where required; optical centering is inspected rather than assumed to be identical.
- [ ] Thin strokes and borders render sharply at the target DPR instead of blurring through accidental half-pixel placement.
- [ ] Transforms, nested coordinate systems, scrolling, and zoom do not detach overlays or connectors from their targets.
- [ ] Coordinate-based SVG/canvas primitives form the intended shape at every target size.

## Typography and glyphs

- [ ] Text does not overlap, clip, wrap unexpectedly, collide with primitives, or escape its container.
- [ ] Line height, baseline alignment, letter spacing, and vertical rhythm are consistent with the design.
- [ ] Centered text is centered on both axes when intended and is not biased by padding, line height, or transforms.
- [ ] Fonts finish loading; no tofu, replacement characters, malformed ligatures, or missing icon glyphs remain.
- [ ] Inspect the actual font used for representative glyphs when fallback matters; a CSS font-family declaration alone is insufficient evidence.
- [ ] Simplified Chinese uses the intended SC glyph forms and does not silently fall back to Japanese or TC forms.
- [ ] Long strings, numbers, localized copy, and dynamic values retain the intended hierarchy and do not break the layout.

## Visibility, composition, and states

- [ ] All primitives remain visible without unintended overlap, clipping, masking, low contrast, or occlusion.
- [ ] Stacking order and overflow rules do not hide content; invisible overlays do not block visible controls.
- [ ] Padding, margins, and gaps follow the intended spacing rhythm and remain consistent among siblings.
- [ ] Visual weight and whitespace are balanced; no side is accidentally hollow, crowded, or biased.
- [ ] Hierarchy, contrast, and focus remain clear at normal viewing size and under supported zoom or reflow.
- [ ] Hover, focus, active, selected, disabled, loading, empty, error, expanded, and scrolled states look correct when applicable.
- [ ] Visible hit areas agree with interactive hit areas, and focus indicators are neither clipped nor obscured.
- [ ] Light/dark or high-contrast variants preserve legibility and intended emphasis when supported.

## Responsive and export fidelity

- [ ] No unintended horizontal scrolling, clipping, off-canvas content, or destructive layout shift occurs.
- [ ] Responsive transitions preserve grouping, reading order, alignment, and usable control sizes.
- [ ] Browser, screenshot, print, PDF, PPTX, image, and embedded-view outputs are inspected separately when they are deliverables.
- [ ] Export page size, crop, scale, color, font embedding, and raster density match the target format.
- [ ] Fixes survive a complete page/deck/state sweep rather than only the originally failing view.

## Measurement guidance

- Use screenshots for perception and rendered geometry for precision; neither replaces the other.
- Use `getBoundingClientRect()`, computed styles, SVG geometry APIs, or renderer-native inspection to compare centers, bounds, padding, and endpoints.
- Judge endpoint tolerance from the design, stroke width, DPR, and viewing scale. Exact numeric equality is not required when antialiasing or optical correction is intentional.
- Validate semantic anchors, not just coincident centers. A line can be centered yet point to the wrong object or wrong edge.
- Use screenshot diffs when a known-good baseline exists. A stable wrong image is still wrong.
- Zoom into suspicious regions, then return to the complete composition to judge balance and regressions.

## Handoff

- [ ] Record the render matrix actually exercised.
- [ ] Preserve focused screenshots or measurements for defects that required judgment.
- [ ] Reopen the final build once more after the last change.
- [ ] Report unresolved defects or untested targets explicitly.
- [ ] Declare completion only after the final rendered output passes.
