# Source and Header-only Dependencies

Use this route when the dependency source is available and the project can pin
and build it as part of the same configure tree.

## Prefer upstream targets over local reconstruction

For an application or private product that owns the final dependency graph, the
best source dependency is an upstream project designed for:

```cmake
add_subdirectory(third_party/foo EXCLUDE_FROM_ALL)
target_link_libraries(app PRIVATE Foo::foo)
```

Pin the vendored revision or archive hash. Configure upstream options for tests,
examples, benchmarks, installation, and optional backends before adding the
subdirectory, but change only options the inspected upstream version actually
supports. Do not patch upstream targets by rediscovering their source files or
duplicating their include directories.

`FetchContent` is another acquisition mechanism, not a different consumption
model. Pin an immutable commit or archive hash and still link the upstream
target. Use its dependency-provider/override facilities when the root must own a
transitive version; do not let configure-time downloads choose moving branches.

## Resolve diamonds before adding both parents

One final target graph gets one copy and configuration of a logical dependency.
When two dependencies contain or request the same library:

- If only one parent uses the nested library, keep that parent's supported
  bundled copy and do not add a second top-level copy.
- If the application or another dependency also needs it, select one pinned
  top-level provider and configure every parent to use that external target.
- If a parent cannot use the selected provider, treat the versions as a real
  compatibility conflict. Do not assume namespacing or static linking makes ODR,
  allocator, exception, or exchanged-type conflicts disappear.

For spdlog/fmt specifically, either use spdlog's bundled fmt alone, or provide
one external `fmt::fmt`/`fmt::fmt-header-only` and enable the inspected spdlog
version's `SPDLOG_FMT_EXTERNAL` or `SPDLOG_FMT_EXTERNAL_HO` mode. Do not compile
spdlog against its bundled fmt while separately treating another fmt as the same
logical dependency.

Apply the same rule to header-only diamonds. Different feature macros or versions
can instantiate incompatible inline definitions even though there is no `.so`.
Put shared compile definitions on the canonical target so every translation unit
sees one configuration.

## Give metadata-free headers an interface target

A genuinely header-only tree needs neither installation nor a fake compilation
unit. Wrap its include tree and required definitions once:

```cmake
add_library(thirdparty_foo INTERFACE)
add_library(ThirdParty::foo ALIAS thirdparty_foo)

target_include_directories(thirdparty_foo SYSTEM INTERFACE
  "${CMAKE_CURRENT_LIST_DIR}/foo/include"
)
```

Use `INTERFACE`, not `PUBLIC`, because an interface library has no compilation
step of its own. Add only requirements proven by upstream headers. Consumers link
`ThirdParty::foo`; they never add the directory themselves.

If this project's public headers expose the vendored library's headers or types,
the dependency has become part of the public contract. Route through
`../deployment/cmake-installable-projects.md` to decide whether consumers find
their own package or the dependency is deliberately shipped as part of the SDK.

## Verify updates as dependency changes

An update changes source, generated code, compile definitions, and sometimes ABI.
Build the direct dependency adapter first, then all final consumers. Exercise the
actual API surface used by the project and one clean configure from the pinned
source inventory; a successful header include alone does not verify a diamond or
configuration change.
