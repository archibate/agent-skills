# Third-party Dependency Router

Load this reference before acquiring, building, finding, vendoring, or wrapping
a library that this project consumes. The output of dependency integration is a
single canonical CMake target with a known provider, version, usage interface,
and ABI contract.

This is the consumer side of the boundary. Publishing this project's own library
or executable belongs to `../deployment/router.md`.

## Route by the dependency surface

| Dependency as received | Load |
|---|---|
| Pinned source tree with an upstream CMake target and `add_subdirectory` support | `source-vendoring.md` |
| Header-only source tree without useful build metadata | `source-vendoring.md` |
| Installed CMake package or maintained `Find*.cmake` module | `installed-and-manual.md` |
| pkg-config package, legacy CMake variables, or non-CMake project installed to a prefix | `installed-and-manual.md` |
| Raw prebuilt `.so`, `.a`, `.dll`, `.lib`, or vendor SDK with headers | `binary-abi.md` |
| Link succeeds but C++ types, callbacks, destruction, or returns crash across the boundary | `binary-abi.md` |
| `[abi:cxx11]`, `std::__cxx11`, compiler/runtime-version, packing, or calling-convention mismatch | `binary-abi.md` |

Load more than one leaf only when the dependency genuinely crosses modes, such
as a non-CMake source build that produces a private-prefix binary SDK with an ABI
constraint.

## Choose who owns the dependency graph

- A final application or private product owns its final link. Prefer a pinned,
  auditable vendored source when upstream supports clean `add_subdirectory`
  consumption; it gives the root project control over version and options.
- A public C++ library shares the graph with downstream consumers. Avoid silently
  embedding a second copy of a common public dependency. Integrate it as a target,
  then use the deployment library route to reproduce the surviving dependency
  with `find_dependency`.
- A prebuilt or closed-source SDK owns its implementation ABI. Treat its stated
  compiler, standard library, architecture, compile definitions, and runtime
  libraries as part of the artifact—not as suggestions.

## Preserve four graph invariants

1. **One logical dependency, one provider and version.** Resolve a fmt/fmt or
   protobuf/protobuf diamond once at the composition root.
2. **One canonical target.** Consumers link the target rather than repeating
   include directories, definitions, library files, and flags.
3. **Usage requirements travel with their owner.** Required headers, transitive
   links, and settings needed by every direct consumer are `INTERFACE`
   requirements of the raw dependency target. Bridge-only ABI switches remain
   `PRIVATE`; the application-facing adapter does not export them.
4. **Acquisition stays replaceable.** Vendored source, an installed config, or a
   prepared prefix may provide the target without changing application targets.

Inspect the exact upstream version before naming targets, variables, features,
or build switches. Prefer upstream config files, `CMakeLists.txt`, pkg-config
metadata, and official integration documentation over remembered spellings.

## Cross into deployment only at an outward boundary

- Public install/export of this project's target: also load
  `../deployment/cmake-installable-projects.md`.
- Portable application that must carry dependency `.so` files: also load
  `../deployment/cpp-app-deployment.md` after the build graph is correct.
- pybind11 wheel that carries native dependencies: also load
  `../deployment/pybind11-packaging.md`.

Changing `RPATH`, copying `.so` files, or bundling glibc cannot repair an
in-process C++ object-layout mismatch. Resolve ABI compatibility here first;
package the verified result second.
