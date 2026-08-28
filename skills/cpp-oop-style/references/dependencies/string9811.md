# string9811 Dual-ABI String Shim

Load this reference only after `binary-abi.md` has identified an unavoidable
libstdc++ ABI-0 `std::string` boundary in a pinned prebuilt dependency, while
the rest of the project is intended to remain on ABI 1.

## Why this hack exists: contain the old string ABI

Setting `_GLIBCXX_USE_CXX11_ABI=0` across the whole project may make the
dependency link, but it also forces every affected translation unit and
dependency edge onto libstdc++'s old string representation. That hard-locks a
modern project to the COW-era string ABI instead of the ABI-1 representation
with modern small-string optimization and behavior. It can expand the
compatibility constraint through the entire target graph.

`string9811` confines that compromise to two bridge translation units. The
application and ordinary dependencies remain ABI 1; only the vendor-facing
representation is ABI 0. It copies characters between two owning proxy values
rather than making the project's normal `std::string` old-ABI.

This is an ABI choice, not a language-mode choice: the ABI-0 bridge may still be
compiled as C++17 or newer. Prefer a current vendor build or an ABI-0 adapter
with a C/POD surface. Use this layout shim only when the binary cannot change
and its narrow string boundary has been proven on the exact toolchain.

## How the historical shim works

The historical implementation uses three views of the same two proxy types:

| Compilation context | `String98` representation | `String11` representation |
|---|---|---|
| Public header / ordinary caller | one pointer of opaque storage | four pointers of opaque storage |
| ABI-0 translation unit | a real ABI-0 `std::string` | opaque storage |
| ABI-1 translation unit | opaque storage | a real ABI-1 `std::string` |

Only the ABI-0 translation unit constructs, copies, observes, and destroys the
old string. Only the ABI-1 translation unit does those operations for the new
string. A cross-ABI constructor asks the source proxy for `data()` and `size()`,
then constructs a fresh string in the destination ABI. Characters cross the
conversion boundary. No translation unit interprets or destroys the other
ABI's string representation, and each ABI retains its own allocator ownership.

This works only as a pinned implementation trick. The repeated class definitions
below are intentionally not equivalent, violating the C++ one-definition rule;
the `reinterpret_cast` in the public helper also relies on the known object
representation. ISO C++ does not guarantee either operation. The point of the
code is to let a fresh maintainer recognize and audit the existing mechanism,
not to recommend it for a new interface.

## Minimal mechanism skeleton

The public header gives callers fixed-size owning proxies. These sizes are facts
about one pinned 64-bit libstdc++ build, not portable constants:

```cpp
// string9811.h
#pragma once

#include <cstddef>
#include <string>

struct String11;

struct String98 {
    String98();
    String98(String98 const &);
    String98 &operator=(String98 const &);
    ~String98();

    explicit String98(String11 const &source);

    char const *data() const;
    std::size_t size() const;

private:
    alignas(void *) std::byte storage[sizeof(void *)];
};

struct String11 {
    String11();
    String11(String11 const &);
    String11 &operator=(String11 const &);
    ~String11();

    explicit String11(String98 const &source);

    char const *data() const;
    std::size_t size() const;

private:
    alignas(void *) std::byte storage[4 * sizeof(void *)];
};

#if not defined(_GLIBCXX_USE_CXX11_ABI)
#error "string9811 requires libstdc++ and its dual-ABI selector"
#elif _GLIBCXX_USE_CXX11_ABI
using CurrentStringProxy = String11;
#else
using CurrentStringProxy = String98;
#endif

static_assert(sizeof(std::string) == sizeof(CurrentStringProxy));
static_assert(alignof(std::string) == alignof(CurrentStringProxy));

inline String98 toString98(std::string const &source) {
    auto const &proxy = reinterpret_cast<CurrentStringProxy const &>(source);
    return String98{proxy};
}

inline String11 toString11(std::string const &source) {
    auto const &proxy = reinterpret_cast<CurrentStringProxy const &>(source);
    return String11{proxy};
}

inline std::string toCurrentString(String98 const &source) {
    return std::string(source.data(), source.size());
}

inline std::string toCurrentString(String11 const &source) {
    return std::string(source.data(), source.size());
}
```

The ABI-0 translation unit deliberately does not include that header. It repeats
the declarations, but makes `String98` own a real old-ABI string:

```cpp
// string98.cpp -- compile only this source with _GLIBCXX_USE_CXX11_ABI=0
#include <cstddef>
#include <string>

static_assert(_GLIBCXX_USE_CXX11_ABI == 0);

struct String11;

struct String98 {
    String98();
    String98(String98 const &);
    String98 &operator=(String98 const &);
    ~String98();
    explicit String98(String11 const &source);
    char const *data() const;
    std::size_t size() const;
private:
    std::string value;
};

struct String11 {
    String11();
    String11(String11 const &);
    String11 &operator=(String11 const &);
    ~String11();
    explicit String11(String98 const &source);
    char const *data() const;
    std::size_t size() const;
private:
    alignas(void *) std::byte storage[4 * sizeof(void *)];
};

String98::String98() = default;
String98::String98(String98 const &) = default;
String98 &String98::operator=(String98 const &) = default;
String98::~String98() = default;

String98::String98(String11 const &source)
    : value(source.data(), source.size()) {}

char const *String98::data() const { return value.data(); }
std::size_t String98::size() const { return value.size(); }

static_assert(sizeof(String98) == sizeof(void *));
static_assert(alignof(String98) == alignof(void *));
```

The ABI-1 translation unit is the mirror image and owns only `String11`:

```cpp
// string11.cpp -- compile only this source with _GLIBCXX_USE_CXX11_ABI=1
#include <cstddef>
#include <string>

static_assert(_GLIBCXX_USE_CXX11_ABI == 1);

struct String11;

struct String98 {
    String98();
    String98(String98 const &);
    String98 &operator=(String98 const &);
    ~String98();
    explicit String98(String11 const &source);
    char const *data() const;
    std::size_t size() const;
private:
    alignas(void *) std::byte storage[sizeof(void *)];
};

struct String11 {
    String11();
    String11(String11 const &);
    String11 &operator=(String11 const &);
    ~String11();
    explicit String11(String98 const &source);
    char const *data() const;
    std::size_t size() const;
private:
    std::string value;
};

String11::String11() = default;
String11::String11(String11 const &) = default;
String11 &String11::operator=(String11 const &) = default;
String11::~String11() = default;

String11::String11(String98 const &source)
    : value(source.data(), source.size()) {}

char const *String11::data() const { return value.data(); }
std::size_t String11::size() const { return value.size(); }

static_assert(sizeof(String11) == 4 * sizeof(void *));
static_assert(alignof(String11) == alignof(void *));
```

Keep the ABI choice source-local. A target-wide ABI-0 definition would also
change the ordinary caller and defeat the bridge:

```cmake
add_library(string9811 OBJECT
  string98.cpp
  string11.cpp
)
target_compile_features(string9811 PUBLIC cxx_std_17)
target_include_directories(string9811 PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")

set_source_files_properties(string98.cpp PROPERTIES
  COMPILE_DEFINITIONS "_GLIBCXX_USE_CXX11_ABI=0"
)
set_source_files_properties(string11.cpp PROPERTIES
  COMPILE_DEFINITIONS "_GLIBCXX_USE_CXX11_ABI=1"
)
set_target_properties(string9811 PROPERTIES
  INTERPROCEDURAL_OPTIMIZATION OFF
  UNITY_BUILD OFF
)
```

## Why a wrong return type can still link

Under the Itanium C++ ABI used by GCC on ordinary Linux targets, a non-template
function's return type is normally absent from its mangled name. That is why an
old-ABI function returning `std::string` may link successfully and then corrupt
memory when a new-ABI caller supplies storage for the new layout.

The stealthy use of `string9811` redeclares that narrow return surface with the
layout-matched proxy without including the incompatible vendor declaration:

```cpp
// The prebuilt ABI-0 library actually defines: std::string legacyName();
// Its return type is absent from this function's linker name.
String98 legacyName();

auto const currentName = toCurrentString(legacyName());
```

Both sides still use the same non-trivial hidden return-storage convention, and
the ABI-0 `String98` destructor releases the allocation. This is another pinned
ABI assumption, not a source-level type-safe conversion. Return-type substitution
does not solve functions whose incompatible type appears in a parameter, nor
does it make methods, templates, callbacks, or overload sets generally safe.
For those, compile a normal ABI-0 adapter translation unit against the real
vendor header and expose a C/POD boundary.

## Pin, isolate, and test the assumption set

Require all of the following before retaining this shim:

- exact compiler, libstdc++, architecture, and build-mode pins;
- size and alignment assertions in the public header and both ABI translation
  units;
- no unity build, LTO, or other whole-program merging across the deliberately
  incompatible definitions;
- one side creates, observes, copies, and destroys each ABI's string;
- boundary tests for empty, short-string-optimized, long, embedded-NUL, copy,
  assignment, return, callback, error, and destruction paths;
- tests against the exact closed-source artifact in Debug and Release, plus a
  repeated-call soak.

Do not generalize the trick to `std::list`, maps containing strings,
`std::function`, exceptions, RTTI, allocators, or vendor classes. Do not infer
that a historical copy is live merely because its object target links. Confirm
actual call sites and tests. Prefer replacing the STL-heavy interface with a
POD/C adapter; retain `string9811` only when the vendor binary cannot be changed
and its narrow return ABI has been demonstrated on the pinned toolchain.
