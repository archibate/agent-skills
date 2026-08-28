# Installable CMake Libraries and CLI Tools

Use this route for a public C++ library or a geek-oriented command-line tool
whose users are expected to configure, compile, and install from source. The
release contract is a conventional CMake install tree plus a clean source
`.tar.gz`, not an end-user application bundle.

## Keep the two prefixes distinct

There is no standard `CMAKE_INSTALL_PREFIX_PATH` variable. Use the two real
interfaces for their separate jobs:

- `CMAKE_INSTALL_PREFIX` chooses where this project installs. Set it while
  configuring, or override one installation with `cmake --install ... --prefix`.
- `CMAKE_PREFIX_PATH` tells a consuming configure where to search for installed
  dependency prefixes, including this package's config file.

Never hard-code `/usr` or a developer's home directory. The installer or
packager owns the prefix.

```bash
cmake -S . -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/chosen/prefix
cmake --build build
cmake --install build

# Equivalent one-install override:
cmake --install build --prefix /another/prefix
```

On Unix, `DESTDIR` is an outer staging root used by distro/package builders; it
does not replace the logical install prefix recorded in the package. Keep that
distinction intact when a later DEB/RPM pipeline stages this install tree.

## Install a public library as a CMake package

An installable library is a real distribution boundary, so `STATIC` or
`SHARED` is appropriate. Give it the same target-based requirements used in the
build tree, then describe both include locations:

```cmake
include(GNUInstallDirs)

add_library(widget STATIC)
add_library(Widget::widget ALIAS widget)

target_include_directories(widget
  PUBLIC
    "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
    "$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>"
)

install(TARGETS widget
  EXPORT WidgetTargets
  ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
  LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
  RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
  INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
)
install(DIRECTORY include/
  DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
)
install(EXPORT WidgetTargets
  FILE WidgetTargets.cmake
  NAMESPACE Widget::
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/Widget
)
```

If the project's minimum CMake supports header file sets and the repository
already models headers that way, install `FILE_SET HEADERS` with the target
instead of duplicating the header list. Do not raise the CMake minimum merely to
copy this spelling.

Generate relocatable config and version files with
`CMakePackageConfigHelpers`:

```cmake
include(CMakePackageConfigHelpers)

set(widget_cmake_dir "${CMAKE_INSTALL_LIBDIR}/cmake/Widget")

configure_package_config_file(
  cmake/WidgetConfig.cmake.in
  "${CMAKE_CURRENT_BINARY_DIR}/WidgetConfig.cmake"
  INSTALL_DESTINATION "${widget_cmake_dir}"
)
write_basic_package_version_file(
  "${CMAKE_CURRENT_BINARY_DIR}/WidgetConfigVersion.cmake"
  VERSION "${PROJECT_VERSION}"
  COMPATIBILITY SameMajorVersion
)
install(FILES
  "${CMAKE_CURRENT_BINARY_DIR}/WidgetConfig.cmake"
  "${CMAKE_CURRENT_BINARY_DIR}/WidgetConfigVersion.cmake"
  DESTINATION "${widget_cmake_dir}"
)
```

The config template includes installed dependencies before importing targets:

```cmake
@PACKAGE_INIT@

include(CMakeFindDependencyMacro)
find_dependency(Threads)

include("${CMAKE_CURRENT_LIST_DIR}/WidgetTargets.cmake")
check_required_components(Widget)
```

Add `find_dependency` for every external imported target that survives in the
installed link interface. Inspect static-library exports especially carefully:
a dependency used to finish the final link may still be required by consumers.
Do not leak absolute source paths, build paths, or developer-specific library
paths into an installed interface.

The exported CMake link interface and the runtime loader closure are different.
A `PRIVATE` shared dependency may be absent from `WidgetTargets.cmake` while
remaining in the installed library's ELF `DT_NEEDED` list. Choose explicitly:

- require that runtime library as an external prerequisite of the installed SDK;
  or
- install a redistributable private copy with a relocatable runtime lookup and a
  tested ownership/update policy.

Do not point an SDK package config into an application's private bundle. Run the
external consumer after linking so its loader closure is tested as well as its
CMake discovery.

If a shared library is public, choose its ABI/versioning policy deliberately.
Do not imply a stable ABI merely by setting `VERSION` and `SOVERSION`.

## Install a geek-oriented CLI narrowly

Install the executable to `${CMAKE_INSTALL_BINDIR}`. Install completions,
manuals, licenses, and runtime data only when those artifacts actually exist.
Do not export a CLI target or generate a package config unless downstream CMake
projects genuinely link to something it provides.

```cmake
install(TARGETS widget_cli
  RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)
```

Source installation is a feature here: it lets the user's own compiler,
standard library, glibc, package manager, and target CPU match the local distro.
It is not the primary interface for a non-geek end-user application.

## Prove the installed contract

Do not stop after testing the build tree. Stage an installation into a fresh
prefix, then configure an external consumer only through the installed package:

```bash
cmake --install build --prefix /tmp/widget-stage
cmake -S consumer -B consumer-build \
  -DCMAKE_PREFIX_PATH=/tmp/widget-stage
cmake --build consumer-build
```

The consumer should use `find_package(Widget CONFIG REQUIRED)` and link
`Widget::widget`. This catches missing headers, missing transitive dependencies,
non-relocatable paths, and incomplete exports that in-tree tests conceal.

## Publish the source `.tar.gz`

Create the archive from a clean tagged source tree. Include everything required
to configure and build, plus the actual license and notices; exclude build
trees, caches, editor state, and generated local artifacts. Do not silently
depend on Git submodules or downloaded files absent from the archive.

Before release, unpack the exact `.tar.gz` into a fresh directory and run the
full configure, build, test, install, and external-consumer sequence from that
copy. The archive—not the maintainer's checkout—is the release input.
