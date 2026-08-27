# Debug Harnesses, REPLs, and Developer Surfaces

Replace repeated source-edit observation loops with a controllable execution
surface. Start with the smallest useful harness; promote its controls into a
durable developer surface only when repeated diagnosis, support, or calibration
justifies it.

## Stop the repeated rebuild loop

After two instrument -> rebuild -> observe cycles that still do not locate the
culprit, do not begin a third cycle of the same shape. Repeatedly editing what is
visible becomes slow and error-prone. Build a harness, REPL, or batched runner
that can exercise many cases without another compilation.

Count cycles where source is edited mainly to change observation. A code change
made after the culprit is established is not another instrumentation cycle.
Before the final bounded reproduction, use `debug-instrumentation.md` to capture
all plausible discriminator state together rather than adding one narrow probe at
a time.

## Build the smallest useful harness

Default to a separate executable that links only the relevant production modules.
It must call the exact production implementation rather than copy its logic.
Avoid starting the integrated application when the module can operate by itself.

Choose the smallest control surface that supports the investigation:

- Command-line arguments or input files for independent cases and parameter
  sweeps.
- A stdin/stdout REPL when commands must observe and mutate state across a
  sequence. Give it typed commands and machine-readable results rather than a
  natural-language interpreter.
- A development mode inside the application when the bug genuinely requires its
  lifecycle or unavoidable heavy dependencies. Expose that mode through stdio,
  a named pipe or Unix socket, or an existing HTTP API. Add a new REST server only
  when it is the simplest faithful boundary.
- A table-driven batch runner when interactive control is infeasible. Execute all
  edge cases that remain plausibly capable of causing the symptom in one run.

## Fall back to GDB for integrated-only reproductions

When no existing harness or developer console fits and the bug requires a
complicated full-process setup with unavoidable dependencies, use GDB's
line-oriented REPL before adding another in-process console. It can inspect
threads, frames, variables, memory, and broad reachable state without editing or
recompiling the source. Use repeated `-ex` options or an `-x` command file when
the probe should be reproducible rather than conversational.

Useful symbolic debugging requires matching debug information. For a
debugger-oriented GCC build, prefer `-Og -ggdb`; use `-ggdb3` when macro
definitions or other level-3 detail is useful. Let the toolchain select its
current expressive format, normally DWARF, rather than using obsolete
`-gstabs+`, which is a compatibility no-op on current GCC.

Optimized code remains debuggable, but inlining, elimination, and reordered
control flow can hide locals and make source locations surprising. If only the
Release build reproduces the bug, keep its exact optimization and provide its
matching symbols instead of switching to a Debug build that erases the symptom.
Breakpoints, watchpoints, and inferior calls can themselves perturb timing or
state; keep that possibility in the hypothesis set. On Linux, live launch or
attachment also requires `ptrace` permission in the execution environment.

Once an integrated reproduction identifies the responsible module, reduce it to
the smallest standalone harness or deterministic test that still fails. Make
external side effects and their targets explicit.

## Promote recurring controls into module duties

Promote controls that remain useful beyond one investigation, especially when
the full application is costly to start, the failing environment belongs to a
software user, or live calibration is routine. A definite module with a complete
executable oracle does not need a developer console.

Keep only the duties the module needs:

| Duty | Module-owned shape | Possible adapters |
|---|---|---|
| Snapshot | typed, read-only state and bounded recent events | harness output, console dump, bug report |
| Tuning | validated parameter data with defaults and bounds | CLI, slider, config, sweep |
| Command | named operations with typed results | harness, REPL, support session |

CLI arguments, stdin/stdout REPLs, local IPC, loopback APIs, and development GUIs
are adapters over these duties. Start with one adapter. Keep parsers and transport
outside the module contract: map input into typed operations rather than exposing
`setParam(string, string)` or arbitrary evaluation.

A console or GUI thread must stage changes and apply them at a defined safe point,
such as a frame boundary, module tick, or event-loop turn. Capture coherent
snapshots at the same boundary. Use the same validation and state transitions as
the production path and return a typed rejection for impossible state.

## Compose and support the durable surface

A development target may link the full console or remote-control adapter. A
client Release may retain a default-off local surface when its footprint and
command inventory are appropriate. A runtime switch prevents accidental use; it
does not remove a capability. Omit commands that must not exist from the Release
composition, preferably through target or source selection around the adapter.

For an interactive support session, let the software user enable and terminate
it, show when it is active, and expose a bounded command inventory. Do not turn it
into a shell. A customer-created diagnostic bundle may include build and module
versions, relevant configuration and tunables, a coherent snapshot, bounded
recent events, reproduction actions, and returned errors. Exclude secrets and
unrelated user data at the source; let the user inspect the bundle before sending
it when feasible. Treat memory dumps as separate sensitive artifacts.

For visual placement, thresholds, animation feel, audio levels, or other
judgment-dependent behavior, expose live bounded controls instead of repeating
"move it a little" recompilation loops. Keep the parameter type, default, bounds,
step, and unit with the owning module. Provide live preview plus reset, cancel,
and apply semantics, show the current value, and export the result to a loadable
configuration or source-ready artifact.

## Optimize iteration time without changing the bug

Build only the harness target and its required libraries. When the bug reproduces
without release optimization, use `-Og` or `-O1` with debug information to shorten
compilation and retain useful source-level inspection.

Some timing-, race-, layout-, undefined-behavior-, or optimizer-sensitive bugs
disappear in that configuration. Preserve the original failing flags when the
diagnostic build does not reproduce the phenomenon.

If an otherwise-correct diagnostic build is unusably slow because of a known hot
kernel, compile that kernel or translation unit with its release optimization.
Prefer a per-source build option. GCC/Clang function-level
`optimize("O3")` is a localized, non-portable fallback. Confirm the final fix in
the original release configuration.

## Finish the investigation

Keep the harness when it remains a useful development surface. Move a discovered
deterministic rule into a focused test; remove hypothesis-specific controls.
Verify the smallest repaired unit first, then the original integrated reproduction
under its failing build configuration.
