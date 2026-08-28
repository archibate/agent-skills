# Installed, pkg-config, and Manual Dependencies

Use this route when the dependency is supplied outside the main configure tree,
or when its own build system must prepare an install prefix before this project
can consume it.

## Inspect before choosing the CMake surface

For the exact upstream version, check in this order:

1. official integration documentation and installed package files;
2. exported targets in `*Config.cmake` / `*Targets.cmake`;
3. a maintained CMake `Find*.cmake` module;
4. pkg-config `.pc` metadata;
5. documented include, compile, and link flags.

Do not guess a target name from the project name or preserve legacy variables
when the package already exports a target.

## Prefer the richest available target

An installed CMake config is the direct route:

```cmake
find_package(Foo CONFIG REQUIRED)
target_link_libraries(app PRIVATE Foo::foo)
```

For a non-standard prefix, provide `Foo_DIR` or `CMAKE_PREFIX_PATH` at configure
time. Keep machine-specific absolute paths out of committed project files.

When only a CMake find module exists, prefer the imported target it exposes. If
the module returns only variables, wrap them once in a local facade target rather
than spreading them across consumers.

For pkg-config, request CMake's imported target:

```cmake
find_package(PkgConfig REQUIRED)
pkg_check_modules(FOO REQUIRED IMPORTED_TARGET foo)
target_link_libraries(app PRIVATE PkgConfig::FOO)
```

The imported target carries include directories, compile options, link options,
and libraries represented by the `.pc` file. Verify that private/static metadata
is adequate before choosing static linkage.

Point `PKG_CONFIG_PATH` at the exact directory containing additional private
`.pc` files; it is searched before the tool's default directories.
`PKG_CONFIG_LIBDIR` replaces the compiled-in default search set and therefore
belongs to an intentionally isolated or cross-compilation toolchain. Derive the
directory from the actual installed prefix—do not assume every project uses
`lib/pkgconfig` or the same multiarch layout.

## Normalize legacy variables and documented flags

Create one facade when the available integration surface is only variables:

```cmake
add_library(thirdparty_foo INTERFACE)
add_library(ThirdParty::foo ALIAS thirdparty_foo)

target_include_directories(thirdparty_foo SYSTEM INTERFACE ${FOO_INCLUDE_DIRS})
target_link_libraries(thirdparty_foo INTERFACE ${FOO_LIBRARIES})
```

Translate documented flags by meaning: `-I` to include directories, `-D` to
compile definitions, compiler flags to compile options, linker flags to link
options, and library files to link libraries or imported targets. Do not append
the vendor command line wholesale to `CMAKE_CXX_FLAGS`.

A raw binary path, compiler ABI constraint, or C++ type crossing the boundary
raises this to `binary-abi.md`.

## Prepare non-CMake libraries outside the main configure

When upstream uses Meson, Autotools, a handwritten Makefile, or another build
system, run its documented configure/build/install flow in an explicit dependency
bootstrap or superbuild stage. Install into a controlled project/team prefix,
then let the main CMake configure consume that prefix through a config package,
pkg-config, or one maintained facade target.

Do not run an opaque `make install` through `execute_process` during ordinary
CMake configure. It creates hidden mutable machine state and makes reconfigure,
clean, and offline builds unpredictable.

Record the dependency version, source or artifact identity, build options,
compiler/toolchain, prefix layout, and update test. A shared prefix is a managed
artifact repository, not an excuse to depend on whichever `/usr/local` contents
happen to exist.

## Verify the consumer surface

Configure in a clean environment using only the declared prefix or pkg-config
path. Compile and link a minimal real consumer, then run it when the library has
a runtime component. This distinguishes successful discovery from a complete
link interface and from an actually loadable binary.
