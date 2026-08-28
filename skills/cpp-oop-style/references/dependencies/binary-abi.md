# Binary SDK and C++ ABI Boundaries

Use this route for prebuilt or closed-source SDKs and whenever a dependency links
but crashes while exchanging C++ objects, callbacks, ownership, or exceptions.
Successful symbol resolution is not ABI proof.

## Classify the boundary before wrapping it

Risk increases sharply across these surfaces:

1. C functions over fixed-width POD, byte buffers, and opaque handles;
2. C++ virtual interfaces using only stable scalar/POD parameters;
3. concrete classes, inline methods, templates, STL containers, `std::function`,
   exceptions, RTTI, or allocation/deallocation crossing the binary boundary.

Prefer a current vendor build matching the project's compiler, standard library,
architecture, and build mode. A vendor C ABI or newer POD-oriented interface is
usually safer than adapting a legacy STL-heavy ABI.

Wrap the raw artifact as an imported target so its location and requirements have
one owner:

```cmake
add_library(vendor_sdk_raw SHARED IMPORTED)
set_target_properties(vendor_sdk_raw PROPERTIES
  IMPORTED_LOCATION "${CMAKE_CURRENT_LIST_DIR}/lib/libvendor.so"
  INTERFACE_INCLUDE_DIRECTORIES "${CMAKE_CURRENT_LIST_DIR}/include"
)
```

Add documented transitive libraries, compile definitions, link options, and
per-configuration locations to that target. Keep `vendor_sdk_raw` private to a
project-owned adapter target; application modules consume the adapter.

## Diagnose the ABI before changing flags

Read the vendor's compiler/build requirements and inspect the exact artifact with
`file`, `readelf`, and `nm -C`/`objdump -T`. For trusted dynamic objects, inspect
their loader closure too. Compare:

- architecture, compiler family/version, standard library, and GLIBCXX/GLIBC
  symbol requirements;
- `_GLIBCXX_USE_CXX11_ABI`, `_GLIBCXX_DEBUG`, packing/alignment, visibility,
  calling convention, exception, and RTTI settings;
- which side creates, owns, mutates, and destroys every object or buffer.

Undefined references containing `std::__cxx11` or `[abi:cxx11]` strongly suggest
a libstdc++ dual-ABI mismatch. Enable `-Wabi-tag` on the adapter while diagnosing.
A crash can be subtler: return types are often absent from Itanium symbol names,
so a function can link while the caller interprets an old-layout return object as
the new layout.

## Use the libstdc++ dual-ABI switch narrowly

The exact macro is `_GLIBCXX_USE_CXX11_ABI`, normally set to `0` for the old ABI.
It must be defined before any libstdc++ header in each affected translation unit:

```cmake
target_compile_definitions(vendor_sdk_abi0 PRIVATE
  _GLIBCXX_USE_CXX11_ABI=0
)
```

The switch is independent of `-std=c++11`/`-std=c++17`; it selects libstdc++'s
old or new implementations of affected types such as `std::string` and
`std::list`. Defaults can differ between distro toolchains. It does not repair
arbitrary GCC-version, libc++, MSVC, `std::function`, vtable, exception/RTTI,
packing, allocator, glibc, CPU, or architecture mismatches.

Do not make the definition project-global merely to satisfy one SDK. Use this
mitigation order:

1. obtain or rebuild a vendor library for the current ABI;
2. isolate a whole adapter target in the vendor ABI when its boundary can avoid
   affected C++ types;
3. compile a narrow ABI-0 bridge that calls the SDK and exposes C/POD operations
   to a normal-ABI wrapper;
4. use a layout-aware dual-ABI conversion shim only as a pinned, tested last
   resort.

The bridge owns vendor objects and catches vendor exceptions. Cross it with
opaque handles, fixed-width structs, `char const *` plus length, explicit status
values, and callbacks with documented lifetime. Copy text or bytes across; free
memory on the same side that allocated it.

## Escalate to `string9811` only to contain an unavoidable ABI-0 string

Do not set `_GLIBCXX_USE_CXX11_ABI=0` across a modern project merely because
one prebuilt dependency exposes the old libstdc++ string ABI. That would make
all affected translation units use the old COW-era string representation and
spread the dependency's compatibility constraint through the target graph.

First prefer a matching vendor build or an ABI-0 adapter with a C/POD boundary.
When neither is possible and a narrow old-ABI string surface must coexist with
an otherwise ABI-1 project, read `string9811.md` for the layout proxy,
source-local CMake definitions, return-value linker trick, assumption pins, and
tests.

## Verify the shipped binary boundary

Test against the exact vendor artifacts, not a substitute build. Cover creation
and destruction, both allocation directions, callbacks after startup/shutdown,
empty and large values, error paths, repeated reconnect/reload, and sanitizer or
debug runs where compatible. Run a release-mode soak for callbacks and ownership
because ABI bugs often survive a one-call smoke test.

After the boundary is sound, route runtime `.so` packaging through
`../deployment/cpp-app-deployment.md`. RPATH or a bundled loader selects files;
it cannot make incompatible C++ object layouts compatible.
