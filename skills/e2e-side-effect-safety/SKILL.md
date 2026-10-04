---
name: e2e-side-effect-safety
description: >-
  Mandatory safety gate before designing or running nontrivial execution tests,
  integration tests, browser/GUI/audio/PTY/filesystem/configuration E2E, or
  deployed hardware tests on a personal or shared computer. Prevent disturbing
  the user or other agents; require verified private resources, silent checks
  first, and explicit approval for unavoidable external effects or user-dependent
  verification. Pure unit tests without real-world I/O effects are exempt.
---

# E2E side-effect safety

The computer is a shared, occupied space, not an empty test sandbox. Assume the
user may have left the agent running while working, listening to music, playing
video games, or sleeping. Other agents may be doing healthy work concurrently.
A passing test does not justify disturbing any of them.

This gate is mandatory before nontrivial execution testing, including test
setup, probes, retries, and cleanup. A test called “unit,” “headless,” “local,” or
“background” is not exempt if it can have real-world I/O effects. Only trivial
unit tests without those effects are exempt.

## Gate before execution

1. Trace the test's effects through its actual consumers: output, input,
   sockets, sessions, processes, services, devices, and resource load. Include
   defaults and fallback behavior, not just the intended route.
2. Identify what this agent owns. Use a private scratch directory and fresh,
   test-specific resource names. Verify isolation before activating effects;
   sharing a Unix user, executable name, or project does not establish ownership.
3. Decide whether the test can run without interrupting the user or another
   agent. If ownership, routing, or isolation is uncertain, fail closed: inspect
   or redesign the test rather than trying the risky route to discover its effect.
4. Bound duration, concurrency, and CPU/GPU/memory/I/O load. Private names do not
   prevent a heavy test from disturbing games, work, or other agents. Start small
   and avoid unnecessary parallel runs or repeated spinning.
5. Run the verified non-disturbing checks first. Record what they establish and
   what still requires a disturbing or user-dependent closing test.

Task authorization, “run E2E,” and a successful earlier isolated test do not grant
permission to disturb the user's session or act on physical devices. A requested
installation or deployment is separately authorized work, scoped to the requested
application and changes; it does not authorize arbitrary test-only mutations of
global configuration or shared infrastructure. Recheck the gate when the execution
route or possible effects change.

## Isolation for the relevant channel

- **Filesystem/configuration:** run tests in an agent-owned isolated scratchpad
  or workspace with private fixtures, outputs, and curated test configs. Use the
  CLI's explicit config-path override (such as `-c`, where supported), or scoped
  `HOME`/`XDG_*` environment overrides. Verify the actual read/write paths and
  fallback behavior, including child processes; changing the working directory
  alone does not isolate global config. Keep test-only installs, deployments,
  and service instances private. Do not modify global/system configs or toggle
  shared services solely for E2E: “install this app when done” does not authorize
  switching Apache on/off or rewriting shared Nginx config for verification.
  If a test depends on those mutations, redesign it or report the verification
  gap; do not use backup-and-restore as a substitute for isolation.
- **Audio:** silence or redirect only the test's output. Verify the effective
  browser/process mute or private output route before playback; headless alone
  does not mean silent. Measure the internal signal upstream of a silent output,
  or use offline rendering. Leave the user's music, games, audio devices, and
  system volume untouched.
- **PTY/tmux:** create a private socket inside this agent's scratch directory and
  pass that socket explicitly on every invocation, including cleanup. Verify its
  path. Do not use or reset the user's default tmux server or another agent's
  sessions.
- **GUI:** run in an agent-private desktop, such as an isolated Xvfb display.
  Set an explicit private `DISPLAY` and verify routing on both the application
  and screenshot/input tools, including `xdotool`; prevent fallback to the user's
  Wayland session. Keep clicks, keystrokes, focus, and screenshots out
  of the user's main desktop. If private-desktop routing cannot be established,
  do not launch or interact there without approval.
- **Embedded/physical systems:** perform simulator, mocked-device, and isolated
  checks first. Deploying or exercising firmware on hardware such as an ESP32
  that can move a robot arm or operate an AC remote requires explicit approval.
  Asking the user to watch or confirm physical behavior also requires approval;
  it is not a free verification step.
- **Concurrent agents:** use test-owned instances, ports, sockets, profiles, and
  process groups. Do not free a resource by killing an unrelated current owner. Never use
  broad process-name kills, reset shared services, or “clean up” unknown healthy
  work. Inspect conflicts and choose a private resource instead.

The list above is demonstrative, not a full enumeration. Think if your E2E test
is disruptive and how to isolate.

## When disturbance is essential

Finish the safe checks and prepare the shortest bounded closing test before
asking. Explain, in one request:

- What the best-effort non-disturbing tests already verified and the remaining
  uncertainty.
- The exact effect, affected resources, and what the user would need to pause or
  observe, including whether other agents would be affected.
- The expected disturbance window, stop condition, and owned-resource cleanup.

Then pause and wait for the user to return and explicitly approve that scoped
window. Silence, background execution, or an unanswered request is not consent.
Do not substitute a more disruptive test while waiting. Once approved, run only
that scope, minimize the interruption, and stop promptly. A longer window or a
changed effect requires renewed approval. If approval is unavailable, report the
remaining verification gap without claiming the unperformed test passed.

## Cleanup and recovery

Clean up only resources whose ownership this agent established. Keep the user's
session and other agents' healthy work intact on success, failure, cancellation,
and retries; do not restore guessed global state over concurrent changes.

If unexpected disturbance occurs, stop the owned test immediately. Inspect what
happened, acknowledge the effect, explain a non-disturbing recovery plan, and
wait for approval before further state-changing work. Do not stop or mute the
user's activity to hide the test's effect.

Report the verified isolation and checks performed, plus any physical or
user-session behavior deliberately left untested. This is an instruction-level
gate: do not claim it is an OS-enforced sandbox or that other already-running
agents have automatically adopted it.
