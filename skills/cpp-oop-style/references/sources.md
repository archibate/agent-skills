# Sources and Further Reading

Load this reference when verifying the provenance or rationale of a rule, or
when looking for deeper examples and study material.

## Primary source material

The main source is <https://github.com/parallel101/cppguidebook>, especially
`design_virtual.md`, `no_more_new.md`, `type_rich_api.md`, `design_functor.md`,
`design_gamedev.md`, `error_code.md`, `cpp_lifetime.md`, `lambda.md`,
`functions.md`, `auto.md`, `design_concept.md`, and `platform.md`.

The companion <https://github.com/parallel101/course> material covers the
`design`, `stl`, and `cmake` sessions, including singleton, get/set, type
erasure, and move semantics. The CMake-first project guidance comes specifically
from course `01` (CMake foundations), `11` (modern CMake), and `16` (modular
CMake project management), including their `slides.pptx` decks and numbered
`CMakeLists.txt` examples.

Installation and package-config guidance is checked against the official CMake
documentation for [`install()`](https://cmake.org/cmake/help/latest/command/install.html),
[`GNUInstallDirs`](https://cmake.org/cmake/help/latest/module/GNUInstallDirs.html),
and
[`CMakePackageConfigHelpers`](https://cmake.org/cmake/help/latest/module/CMakePackageConfigHelpers.html).
CMake configuration-profile guidance follows the official
[`cmake-presets(7)` manual](https://cmake.org/cmake/help/latest/manual/cmake-presets.7.html).
Python extension guidance follows pybind11's official
[compiling documentation](https://pybind11.readthedocs.io/en/stable/compiling.html),
including its scikit-build-core example. AppImage compatibility claims follow
its official [best-practices page](https://docs.appimage.org/reference/best-practices.html),
which treats AppImage as a distribution format and requires an old-enough build
baseline plus testing on intended base systems.

The ultimate Linux-bundle route is based on
[`archibate/mockup`](https://github.com/archibate/mockup/tree/c515d878ce38e68817c9060160b759ad1ca24238),
specifically its `README.md` and `mockup.py` implementation: recursive `ldd`
discovery, a bundled matching dynamic loader and glibc, optional `$ORIGIN`
patching, and a single-file self-extracting wrapper. The skill states the
implementation's remaining kernel, architecture, dynamic-loading, resource,
and wrapper-tool boundaries instead of repeating the repository's unlimited
portability slogan.

Third-party integration guidance is checked against CMake's official
[using-dependencies guide](https://cmake.org/cmake/help/latest/guide/using-dependencies/index.html),
[imported-target guide](https://cmake.org/cmake/help/latest/guide/importing-exporting/index.html),
and [`FindPkgConfig`](https://cmake.org/cmake/help/latest/module/FindPkgConfig.html).
The libstdc++ compatibility rules follow GCC's official
[Dual ABI](https://gcc.gnu.org/onlinedocs/libstdc++/manual/using_dual_abi.html)
documentation. The fmt/spdlog diamond example uses spdlog's supported
`SPDLOG_FMT_EXTERNAL` and `SPDLOG_FMT_EXTERNAL_HO` switches rather than assuming
how its bundled fmt is wired.

## Exemplar code

- <https://github.com/archibate/co_async> — design idioms.
- `parallel101/opengltutor`'s `check_gl.hpp` — a clean RAII C-handle wrapper.

## General references and tools

- References: cppreference.com, hackingcpp.com, learncpp.com.
- Inspection and benchmarking: godbolt.org, cppinsights.io, quick-bench.com.
