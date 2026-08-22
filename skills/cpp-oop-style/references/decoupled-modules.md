# Decoupled Modules and Verification Surfaces

Design module boundaries around what can be verified in isolation. Separate
definite computation from tacit interaction before choosing classes, targets,
or tests.

## Separate definite modules from tacit boundaries

Ask whether correct behavior can be fully stated as an executable oracle before
implementation:

| | Definite module | Tacit boundary module |
|---|---|---|
| Correctness | Deterministic assertions can describe it | Judgment, interaction, or a real environment is part of the evidence |
| Typical work | Algorithms, math, pure transformations, fully modeled business rules | GUI reactions, external I/O, environment-dependent workflows |
| Shape | Values in, values out; no hidden environment | Thin adapter between external effects and domain values |
| Verification | Automated unit tests lock specified behavior and edges | An agent drives and observes a standalone development harness |
| Standalone entry | Optional when tests cover the contract | Required; use an executable or a host application's development flag |

A business rule remains definite when its I/O contract has a faithful, trivial
fake. If a fake would reproduce only guesses about the real environment, the
boundary is tacit; hard-coded mock responses do not make it definite.

Do this separation while decomposing the requirements, not after producing a
mixed module. Keep the tacit module as small as possible:

1. Read bytes, events, or external state at the tacit boundary.
2. Convert them into typed data and pass that data to definite modules.
3. Return value results to the boundary for display, storage, or transmission.
4. Move any newly discovered deterministic rule out of the boundary.

## Keep the seam smaller than the modules

A module boundary does not automatically require a virtual interface. A
definite, closed-set algorithm may expose a value or function API. Use an
abstract interface when the seam needs runtime dispatch, implementation hiding,
or dependency injection.

The side whose policy the contract expresses owns the interface. A subsystem
owns commands entering it; a consumer owns the service or callback port it
requires. Concrete implementations and third-party types stay behind that
contract. Only composition roots — the production root and development
harnesses — include concrete modules and wire them together; modules do not
reach across the boundary through globals or concrete cross-includes.

## Give tacit modules an agent-operable harness

Default to a separate development executable. Use a flag or subcommand on the
real application only when the subsystem needs that application's lifecycle or
GUI host.

The harness must:

- invoke the exact production control-flow path instead of copying its logic;
- accept adjustable inputs through command-line arguments, standard input, or
  files instead of exposing only compiled scenarios;
- expose enough output, state, events, and diagnostics for an agent to judge the
  behavior from a shell;
- live as ordinary buildable C++ source so an agent can instrument, recompile,
  and rerun it during diagnosis; and
- make external side effects and their targets explicit.

Automated tests may still lock the definite invariants of a tacit module, but
they do not replace interactive exploration. Do not freeze the implementation's
current output as an expected result when the correct result itself requires
judgment.

## Integrate only independently verified modules

1. Make every definite module's unit tests pass, including its specified edges.
2. Build each tacit module's harness and exercise the relevant control-flow
   paths, retaining the commands and observations as evidence.
3. Wire the verified modules in the production composition root.
4. Add a thin integration smoke test for wiring and data flow; do not duplicate
   the definite module's unit suite.
5. When integration fails, reduce it to a definite unit test or the smallest
   tacit harness before debugging the full application.

Passing unit tests is a gate for definite modules, not a universal proof of
correctness. A tacit module is ready to integrate when its real control path is
independently operable and has been explored with the judgment its contract
requires.

## Example: `sort`

Keep the algorithm and I/O in separate targets:

```text
sort_core        definite sorting library
sort_core_tests  automated algorithm and edge-case tests
sort_io          minimal input/output boundary
sort_io_probe    development executable that exercises I/O without sorting
sort             production composition root: sort_io + sort_core
```

`sort_core` needs no extra launch path when its test oracle covers the algorithm.
`sort_io_probe` lets an agent vary inputs, inspect parsed and emitted data, add
instrumentation, and rebuild without involving the sorting implementation. The
final `sort` binary is assembled only after both sides work independently.
