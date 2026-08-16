---
name: visual-qa
description: Render-first visual quality assurance for frontends, slides, diagrams, SVG/canvas, PDFs, generative-AI images, and other visual artifacts. Use after creating or changing a visual artifact, including with image generation, or when asked to review alignment, spacing, typography, connectors, clipping, factual correctness, responsive layout, font fallback, export fidelity, or visual polish. Inspect the actual rendered artifact, verify generated content against its source data and constraints, measure suspicious geometry, fix visible defects, and render again before completion.
---

# Visual QA

Source correctness is not visual correctness. Treat the rendered artifact as the test subject.

## Verification loop

1. Define the render matrix: target surfaces, viewport sizes, device-pixel ratios, zoom levels, themes, locales, states, and export formats that matter to the task.
2. Build and open the actual deliverable. Reload after rebuilding, wait for fonts, images, hydration, and layout to settle, and avoid validating a stale cached artifact.
3. Capture and inspect every relevant view. For multi-page or multi-state artifacts, review the complete set rather than a convenient sample.
4. Measure suspicious geometry from the rendered layout. Compare bounding boxes, centers, padding, baselines, and connector endpoints; verify what each connector is intended to connect.
5. Fix the defect at the highest semantic layout layer available.
6. Re-render the affected view, then recheck the complete render matrix for regressions.
7. Report the surfaces and states inspected, the evidence used, and any remaining uncertainty.

Use `$agent-browser` for headless web rendering and interaction. Use `$chrome-cdp` when the task specifically requires the user's visible or authenticated Chrome session and the user has approved it. Render non-web outputs such as PDF or slide exports with their target renderer, convert representative pages to images when useful, and inspect those images. Close browser sessions after the pass.

Read [references/checklist.md](references/checklist.md) before reviewing or handing off an artifact with custom layout, connectors, SVG/canvas, dense typography, CJK text, responsive behavior, or multiple pages/states.

## Evidence model

Use visual inspection and measurements together:

- Screenshots reveal balance, semantics, glyph problems, occlusion, and defects that DOM metrics cannot judge.
- Rendered measurements distinguish real misalignment from visual ambiguity and quantify disputed geometry.
- Source review, successful builds, accessibility snapshots, generic overflow checks, or a single viewport are not proof of visual correctness.

Treat automated warnings as leads. Shadows, transforms, and pseudo-elements can create harmless overflow reports, while a page with no reported overflow can still look wrong.

For generative-AI images, compare the visible result with the prompt and source data. Check exact text, numbers and arithmetic, object counts, ordering, labels, color semantics, spatial relationships, omissions, and invented details. For engineering diagrams, validate structure and facts independently of visual plausibility. Make a targeted edit or regenerate, then inspect the new result before handoff.

## Repair hierarchy

Prefer solutions in this order:

1. Use normal flow, Flexbox, Grid, intrinsic sizing, and design tokens for semantic layout.
2. Derive underlines, badges, boxes, and simple decoration from their owning element with borders, backgrounds, or pseudo-elements.
3. Use SVG for genuine vector geometry, charts, and connectors. Derive coordinates from data, anchors, or rendered bounding boxes; use a graph or connector library when routing is non-trivial.
4. Use canvas for high-volume drawing when retained DOM/SVG structure is unsuitable.
5. Use `$imagegen` for raster and illustrative assets, and consider it for engineering diagrams when a raster deliverable is acceptable. An image model's native visual capability can produce strong composition, alignment, and diagram layout, sometimes better than LLM-authored SVG or TypeScript. Treat the result as visually synthesized rather than deterministically correct: specify exact data, labels, and relationships, then sanity-check every visible fact. Prefer code-native geometry when the deliverable requires exact editability, machine readability, reproducibility, accessibility, or automated data binding.

Hard-coded coordinates are legitimate inside stable plots and deliberate vector artwork. They become a defect risk when they duplicate layout facts owned elsewhere. Render and inspect every coordinate-based primitive at its target sizes, and replace fragile coordinates when the shape does not survive that test.

## Completion standard

Finish only after the final artifact itself has been rendered and inspected. A local fix must pass both its focused recheck and a whole-artifact regression pass. Do not claim “pixel-perfect” without screenshot evidence and relevant measurements.
