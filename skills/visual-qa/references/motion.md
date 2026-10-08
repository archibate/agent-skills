# Animation and visible timing

Use alongside the surface reference for animated or time-dependent output,
including transitions, entrances/exits, loading indicators, and TUI redraws.
Correct endpoints do not establish a correct transition. Test appearance through
time, not just after settling. Respect intentional instant changes and the motion
requirements; do not add animation merely because an element currently snaps.

## Identify the motion contract

Trace the interaction and implementation to identify the trigger, starting state,
intended delay/duration, intermediate geometry, end state, and interruption behavior.
Include affected siblings, backgrounds, overlays, and content that loads mid-motion.
Use the requested behavior and existing design as the contract; distinguish a
verified requirement from an inferred preference.

Map relevant visible transitions even when the user has not named an animation
bug. Read the code that owns scheduling, mounting/unmounting, layout, and cleanup.
Use it to identify risky checkpoints and form hypotheses, not as proof that the
actual motion is correct. Define the relevant supported motion/reduced-motion
settings and rendering conditions before capture.

## Capture a timeline

1. Start from a reproducible state at fixed viewing dimensions. Prepare required
   assets unless loading itself is the scenario. Keep capture routing and scale
   consistent with the chosen surface reference.
2. Automate the input and capture sequence in one bounded run. Model/tool round
   trips between screenshots are too irregular to represent a short animation.
   Record the trigger and actual capture timestamps on a consistent clock, noting
   whether timestamps describe frame presentation, sampling, or capture completion.
3. Capture the pre-trigger state, onset, intermediate states, completion, and a
   short post-completion window. Choose cadence from the motion's duration and
   suspected defect; preserve frame order and actual time gaps. Where recording
   is available, extract timestamped real frames for image-only inspection.
4. Inspect a timestamp-labeled contact sheet for progression, then individual
   full-resolution frames around suspicious changes. Include surrounding layout,
   not only the moving element. Densely recapture uncertain intervals if feasible.
   Do not synthesize/interpolate missing frames and treat them as observed evidence.
5. For intermediate geometry, controlled seeking or paused animation checkpoints
   can help where supported. Also run the real input path at normal speed: seeking
   bypasses scheduling and cannot establish responsiveness or playback smoothness.

A screenshot loop can disturb the timing it measures. Keep capture bounded and
lightweight; if it affects the run, separate geometry captures from low-overhead
timing collection. Report sparse sampling or uncertain capture timing as limits.

## Inspect progression and timing

- **Abrupt appearance/disappearance:** inspect the first visible and last retained
  states. Look for flashes, snaps, premature removal, late style application, or
  an intended entrance/exit skipped entirely.
- **Misfit during motion:** inspect clipping, overlap, detached anchors, wrong
  transform origins, wrapping changes, shifting siblings, and changing hit areas.
  A layout that fits at both endpoints can fail between them.
- **Continuity and coordination:** compare position, size, opacity, and other
  relevant properties across timestamped samples. Look for unexplained jumps,
  reversals, stalls, repeated restarts, or elements finishing out of sync. Allow
  intended easing, overshoot, discrete changes, and loops; unequal displacement
  alone is not evidence of lag.
- **Response delay and stutter:** separate input-to-first-visible-response delay
  from intended animation duration and frame delivery. Use renderer/platform
  timing traces when needed to investigate scheduling gaps, expensive work, and
  missed frame deadlines. Callback timing alone does not prove frames reached the
  display; sparse screenshots alone cannot establish frame rate or smoothness.
- **Lifecycle races:** when applicable, retrigger, reverse, cancel/close, navigate,
  resize, or change content mid-transition. Check for stale completion actions,
  stranded overlays, jumps back to old state, lost focus, and blocked input.
- **Reduced motion:** verify supported reduced-motion behavior reaches a usable
  final state without depending on an animation that no longer runs.

## Couple evidence to repairs

For each observed defect, align its timeline with the owning code path. Inspect
suspects such as conflicting layout/animation updates, remounts, delayed asset
arrival, stale timers, early teardown, or expensive per-frame work. Distinguish
observed behavior from the proposed cause; use the smallest discriminating probe.
Do not hide an unexplained defect with a longer duration or arbitrary delay.

Fix the owning transition/layout/lifecycle logic, then repeat the same timeline
and interruption case. Recheck resting states and adjacent transitions for
regressions. Follow the surface reference for tools and the shared safety gate;
this is not permission to run disruptive or unbounded performance tests.

## Completion evidence

Report the transitions exercised, real-time versus controlled sampling, capture
cadence/gaps, timing evidence where collected, and remaining uncertainty. State
separately what the evidence establishes: endpoint appearance, sampled progression,
interruption correctness, or measured delivery timing. With image-only inspection,
report that sampled motion was inspected rather than claiming continuous playback
was watched. Leave perceptual smoothness unverified where capture/timing evidence
cannot support it; do not ask the user to rediscover defects detectable in the
available frames and code.
