# Documents, slides, and paginated exports

## Setup

Identify each deliverable format and its intended renderer/viewer, page or slide
size, and viewing scale. Render the latest output with that renderer; successful
export or source inspection alone does not establish fidelity. For interactive
viewer testing, also load the matching web or desktop route.

## Render and capture

Inspect every page/slide in the agreed scope, converting rendered pages to images
when useful. Check full-page composition at normal viewing size, then zoom into
suspect typography and geometry. Verify captures correspond to the final export,
not a stale preview or earlier generated file.

Inspect distinct deliverables separately: an editable slide deck, exported PDF,
print output, and raster preview can differ even when produced from one source.

## Surface checks

- Verify content and page/slide order, pagination, unintended blank pages, broken
  groups, clipped tables, and text wrapping at page boundaries.
- Check margins, headers/footers, alignment, whitespace, and legibility at intended
  presentation or reading scale. Confirm repeated elements stay consistent.
- Check font embedding/substitution, actual fallback glyphs, missing symbols, and
  CJK forms. Inspect export-specific line breaks and text overflow.
- Verify page size, crop, scale, color, raster density, and vector sharpness match
  the target format. Check transparency and objects near page edges after export.
- For charts, diagrams, or connectors, also load
  [Images and diagrams](images-diagrams.md).
- Repair the source layout or export settings, then regenerate affected formats;
  a fix visible in the authoring preview may not survive export.

## Completion evidence

Reopen the final deliverables after the last change and sweep their pages/states.
Record renderer, format, page coverage, and useful captures or measurements;
explicitly identify uninspected formats/pages or unavailable target renderers.
