---
name: visual-qa
description: >-
  Surface-neutral visual quality assurance for browser UIs, terminal/TUI apps
  requiring PTY interaction, native desktop apps, documents/slides/PDFs, images,
  and diagrams. Use after creating or changing visible output, or when asked to
  test visible interaction states, animation, abrupt transitions, stutter, layout,
  typography, clipping, content accuracy, or visual polish.
---

# Visual QA

Source correctness is not visual correctness. Test the actual current output.
This skill covers appearance and the interaction needed to reach or verify visible
states; it does not replace functional, protocol, or performance testing.

## Choose the surface

Read the matching reference before choosing tools. Load only relevant routes;
combine them when a task spans surfaces.

| When testing | Read |
|---|---|
| Browser UI | [Web](references/web.md) |
| Terminal UI, TUI, or PTY-driven interaction | [TUI](references/tui.md) |
| Native desktop windows or a graphical terminal emulator | [Desktop](references/desktop.md) |
| PDF, slides, or paginated/exported documents | [Documents](references/documents.md) |
| Raster/generated images, vector art, charts, or connectors | [Images and diagrams](references/images-diagrams.md) |

A browser-hosted diagram needs web + images/diagrams. A TUI inspected in a desktop
terminal needs TUI + desktop; PTY interaction alone does not require browser tools.

For any animated or time-dependent output, also read
[Motion](references/motion.md) before testing. This cross-surface route covers
frame sequences, timing, and interrupted transitions; load it even when the user
has not explicitly reported an animation defect.

Apply `$e2e-side-effect-safety` before nontrivial execution tests, including setup.

## Shared verification loop

1. Identify the intended content and constraints. Define the relevant surfaces,
   viewing dimensions, themes, locales, states, and output formats; mark exclusions.
2. Open or render the latest build/output. Use stable states for static checks;
   for motion checks, start capture before the trigger and inspect progression.
3. Exercise relevant visible transitions, including their intermediate states and
   interruptions when applicable. Inspect the agreed views, pages, states, and
   timelines completely, not just endpoints or a convenient sample.
4. Check content against its source; check geometry, alignment, spacing, text and
   glyphs, wrapping, clipping, occlusion, contrast, hierarchy, and visible focus.
   Include content extremes and applicable empty, loading, error, selected,
   disabled, expanded, and scrolled states. Verify hit areas where interactive.
5. Measure suspicious geometry using renderer-native evidence. Fix the defect at
   the semantic layout layer that owns it rather than patching derived coordinates.
6. Re-render after the last change, recheck the affected view, then sweep the
   agreed matrix for regressions. Preserve evidence for defects needing judgment.

## Evidence and completion

Use inspected captures for appearance and rendered measurements for precision.
Check actual glyphs and fallback where typography matters, including intended CJK
forms; a declared font does not prove which glyphs were rendered. Inspect both
suspicious details and the complete composition at the intended viewing scale.

Build success, logs, source review, structural snapshots, and automated warnings
are supporting evidence, not proof of rendered appearance. Screenshot diffs help
with a known-good baseline; a stable wrong image is still wrong. Terminal screen
reconstruction has a narrower evidence boundary, defined in the TUI reference.

Report the surfaces/states actually inspected, evidence used, unresolved defects,
and untested targets. Claim visual completion only after inspecting the final
rendered output and relevant motion; distinguish static, sampled-motion, and timing
evidence, and label state-only verification as such. Do not claim
“pixel-perfect” without screenshot evidence and relevant measurements.
