# CMake-first C++ Projects

Model the project as a graph of CMake targets. The target graph should expose
the same module boundaries, dependencies, and composition roots as the C++
architecture.

## Give each module a target and directory

Use one subdirectory and one `CMakeLists.txt` per module. Even a project with one
initial module benefits from this boundary when more products or backends are
added later.

```text
project/
|-- CMakeLists.txt
|-- cmake/
|-- foo/
|   |-- CMakeLists.txt
|   |-- include/foo/Foo.h
|   `-- src/Foo.cpp
`-- app/
    |-- CMakeLists.txt
    `-- src/main.cpp
```

The root project owns genuinely project-wide policy, initializes `project()`,
and composes subprojects with `add_subdirectory`. A child `CMakeLists.txt` owns
only its target's sources, public include tree, properties, and dependencies.

Public headers live under `include/<module>/` and are included as
`<module/Foo.h>`. Use the module name as the C++ namespace. Mirror a public
header with a same-named `.cpp` when it has out-of-line implementation; keep
private implementation details out of the public include tree.

## Collect sources inside the module boundary

For a greenfield course-style module, prefer a scoped recursive glob with
reconfiguration enabled:

```cmake
file(GLOB_RECURSE foo_sources CONFIGURE_DEPENDS
    src/*.cpp
    include/*.h)

add_library(foo OBJECT ${foo_sources})
target_include_directories(foo PUBLIC include)
```

Including headers in the target makes them visible in IDE project browsers.
Keep the glob rooted in the module's `src/` and `include/` trees. Do not recurse
from the repository root, where an in-source `build/`, generated code, vendored
dependencies, or unrelated tools could become accidental sources. Match an
existing project's explicit-source convention when changing it rather than
performing a mechanical conversion.

Use out-of-source builds:

```sh
cmake -B build
cmake --build build
```

## Choose the target kind from the delivery boundary

- `OBJECT`: an internal implementation module whose object files are folded
  into final products in the same configure tree. This is the default course
  preference when targets organize shipped programs: it avoids static-library
  dead stripping and dynamic-library deployment. Several in-tree consumers —
  including apps, tests, probes, or a host that uses `add_subdirectory` — do not
  by themselves require an archive.
- `STATIC`: a real archive boundary, separately reusable library, or a project
  whose established packaging expects archives.
- `SHARED`: a deliberate runtime, plugin, ABI, or deployment boundary. Account
  for PIC, symbol export, runtime search, and platform-specific deployment.
- `INTERFACE`: a header-only module or a target that carries usage requirements
  without compiling sources.
- `EXECUTABLE`: a product composition root, test, benchmark, or development
  probe that links library targets.

Do not turn every logical C++ class into a target. A target represents a module
with an independently meaningful build boundary and dependency surface.

## Put usage requirements on their owner

Express sources, includes, definitions, options, and links through `target_*`.
The visibility keyword describes who needs the requirement:

| Visibility | Target itself | Consumers | Use when |
|---|---:|---:|---|
| `PRIVATE` | yes | no | implementation source alone needs it |
| `PUBLIC` | yes | yes | the public contract exposes or requires it |
| `INTERFACE` | no | yes | a header-only or imported target passes it onward |

If `foo`'s public header includes a dependency header or exposes its type, link
that dependency `PUBLIC`. If only `foo`'s `.cpp` uses it, link it `PRIVATE`.
Executable dependencies are normally `PRIVATE` because executables rarely have
consumers. Source membership is not automatically a public usage requirement;
implementation sources are normally `PRIVATE` even though compact teaching
examples may use `PUBLIC` uniformly.

Consumers link the direct module target. They inherit its public include paths,
compile definitions, options, and transitive link dependencies; they do not
repeat those details manually.

Directory-global `include_directories`, `link_directories`, `add_definitions`,
and `add_compile_options` leak into targets declared later. Reserve directory or
root-wide settings for policy that is truly uniform across the whole project.

## Use CMake semantics before raw compiler flags

Use CMake's cross-platform property when one exists:

- `CXX_STANDARD` or a project-wide `CMAKE_CXX_STANDARD`, not a raw
  `-std=c++...` flag;
- `CUDA_ARCHITECTURES`, not a raw `-arch=...` flag;
- `POSITION_INDEPENDENT_CODE`, not a hand-written PIC flag.

For a standard shared by every target, initialize the project-wide value in the
root before creating targets. Keep local requirements on the affected target.
When a raw option is genuinely necessary, use `target_compile_options` and
guard it by compiler, platform, configuration, or language as appropriate.

## Import third-party dependencies as targets

Prefer an installed package's modern config and namespaced imported target:

```cmake
find_package(TBB CONFIG REQUIRED COMPONENTS tbb)
target_link_libraries(foo PRIVATE TBB::tbb)
```

The imported target owns its library location, include paths, definitions,
compile options, and transitive dependencies. Do not duplicate those properties
on every consumer.

Discover a dependency in the module that owns the corresponding link edge. Move
discovery to the root only when several child targets deliberately share one
project-wide dependency policy.

Use this order:

1. Use a system or package-manager installation with
   `find_package(... CONFIG ...)` and `Package::component`.
2. For a non-standard install prefix, pass `-DPackage_DIR=...` or
   `-DCMAKE_PREFIX_PATH=...` during configure. Keep host paths out of committed
   `CMakeLists.txt` and avoid global environment settings that couple unrelated
   projects.
3. When no package config exists, use a maintained `FindPackage.cmake` in the
   project `cmake/` directory and extend `CMAKE_MODULE_PATH` from the root.
4. Use legacy `${Package_LIBRARIES}` and `${Package_INCLUDE_DIRS}` only when the
   available finder exposes no imported target.
5. Vendor a third party with `add_subdirectory` only when that project explicitly
   supports embedding and vendoring is a deliberate repository policy.

Mark required dependencies `REQUIRED`. For an optional dependency, omit
`REQUIRED`, test whether its imported target exists, then attach both the link
and feature definition to the consuming target. Preserve a working fallback
when it is absent.

## Keep subprojects embeddable

A reusable subproject must work both as the top-level project and beneath
another project's `add_subdirectory`:

- Use `CMAKE_CURRENT_SOURCE_DIR` or `CMAKE_CURRENT_LIST_DIR` for paths owned by
  the current file. Use `PROJECT_SOURCE_DIR` only when the subproject establishes
  its own `project()` boundary. Avoid `CMAKE_SOURCE_DIR` for module-local paths;
  it points at the outermost host when embedded.
- Keep machine-specific paths in cache or command-line inputs. Do not force cache
  values that belong to the host project.
- Gate top-level-only tests, examples, documentation, and developer tools with
  the project's top-level detection or an explicit option. Use
  `PROJECT_IS_TOP_LEVEL` when the declared CMake minimum supports it. Do not make
  consumers discover dependencies needed only by those extras.
- Set a toolchain before `project()`. After changing a toolchain, configure in a
  fresh build directory so cached compiler state cannot survive the change.
- Let target usage requirements cross module boundaries. Do not use parent-scope
  variables as a substitute for target dependencies.

The course material establishes no house convention for authoring `install()`,
`export()`, package config files, namespaced aliases for first-party targets, or
CTest layout. Supporting `add_subdirectory` alone does not require alias targets,
`BUILD_INTERFACE` / `INSTALL_INTERFACE`, or export scaffolding. Follow the
repository's existing contract or the task's distribution requirements instead
of inventing one from these project-organization rules.

## Materialize verification surfaces as targets

When `decoupled-modules.md` splits definite computation from tacit boundaries,
express each independently operable surface in the target graph: a library for
the module, an executable for a test or probe, and a thin production executable
that composes verified targets. Tests, benchmarks, and probes link production
module targets; they do not copy their sources or control flow.
