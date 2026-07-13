# Error Handling

Default to **value-based** error handling. The shape of the error follows from
one question asked first.

## Classify first: recoverable or not?

Every failure is one of two kinds, and the kind — not taste — picks the mechanism.

### Unrecoverable → don't fake a return

If the caller could never sensibly continue (broken invariant, impossible
config), do not invent an error path the caller must thread. End the program at
the point of failure:

```cpp
[[noreturn]] void fatal(std::string_view msg) {
    std::cerr << msg << '\n';
    std::terminate();
}
```

Mark such functions `[[noreturn]]` so the compiler prunes dead code after the
call. Call sites then read as if the surrounding function "always succeeds" — no
dead error branches.

### Recoverable → return the error, let the caller decide

Report the failure faithfully and hand control back. **Never `exit()` on the
caller's behalf** for a recoverable error — don't commit suicide for the caller.
The caller's business logic decides whether to retry, fall back, or abort.

## Value-based mechanisms (the default)

```cpp
// Nullable result, no extra error info:
std::optional<int> parseInt(std::string_view s);

parseInt("42").value();        // throws std::bad_optional_access if absent
parseInt(s).value_or(0);       // default on absent
if (auto v = parseInt(s)) use(*v);

// Result with a reason:
std::expected<Conn, std::error_code> connect(ConnConfig const &cfg);

if (auto r = connect(cfg)) use(*r);
else log(r.error());
```

- **`optional<T>`** when "absent" needs no explanation.
- **`expected<T, E>`** (C++23; or a hand-rolled equivalent / `tl::expected`)
  when the caller needs the reason. Custom `error_code` categories via a
  static-local singleton are allocation-free and idiomatic.
- Never a sentinel value (`-1`, null pointer, empty string) — the caller forgets
  to check, and the sentinel collides with a real value.

Two `optional` traps: `value_or(expr)` evaluates `expr` **eagerly** even when the
value is present — use `or_else([]{ ... })` when the fallback is expensive. And
`optional<T&>` is ill-formed; hold `optional<std::reference_wrapper<T>>` (or a
plain `T*`) for an optional reference.

For coroutine code, the monadic `co_await co_await expr` idiom (inner await
unwraps the `expected`, outer await short-circuits the current coroutine on
error) propagates failures without exceptions. Reserve exceptions for build-time
opt-in or truly exceptional startup paths.

## Atomic pair operations

Merge operations that must not be split. `stack::top()` + `pop()` invites a
TOCTOU bug and a forgotten emptiness check; a single `optional<T> pop()` is safe
by construction.

## When optional / expected aren't available (pre-C++17)

On an older standard, you don't drop to sentinels — you apply the skill's *one
rule* to errors. A failure is either a **data class** you return or an
**abstract class** you inject.

**Return a result data-class.** A named struct with a status and the payload is
exactly the "data class" half of the skill — self-documenting and impossible to
ignore by accident:

```cpp
struct ParseResult {
    bool ok;
    int value;          // valid only when ok
    ErrorCode error;    // valid only when not ok
};
ParseResult parseInt(std::string_view s);

ParseResult r = parseInt(s);
if (r.ok) use(r.value); else handle(r.error);
```

This is just "return a named struct, never `pair`/`tuple`" applied to fallible
functions. (A hand-rolled `Optional<T>` / `Expected<T, E>` class is the same idea
generalized — and is what `tl::optional` / `tl::expected` give you as drop-ins.)

**Inject an error handler.** When the caller wants one place to deal with all
failures, pass a collaborator implementing an error-sink interface — the
"abstract class" half, an `Spi`-style callback:

```cpp
struct ErrorSink {
    virtual ~ErrorSink() = default;
    virtual void onError(ErrorCode code, std::string_view detail) = 0;
};

void process(Batch const &batch, ErrorSink *sink);   // reports failures, keeps going
```

The function reports faithfully and continues; the injected sink decides policy
(log, collect, abort). This is dependency injection doing error handling — no
new mechanism, just the seam you already use for collaborators.

Pick by shape: a single failable call → result data-class; a long-running
operation with many possible failures handled centrally → injected error sink.

## Pragmatic fallback: bool + log

In a hot path, an embedded/no-exceptions build, or an app-internal routine where
the failure is always handled the same way (log and move on), a plain
`bool`-return paired with a log line on failure is acceptable:

```cpp
bool loadFactorFile(std::filesystem::path const &p);   // false + log on failure
```

This is the production trading-code style — pragmatic, but a *fallback*, not the
default. Public/library API surfaces should still prefer `optional` / `expected`
so callers get a value they cannot ignore.

## Compiler hygiene

- `-Werror=return-type` (MSVC `/we4716`): a missing `return` in a non-`void`
  function is undefined behavior compilers may otherwise wave through.
- Prefer `map.at(key)` over `map[key]` for reads — `at` throws `out_of_range`
  (fail fast); `[]` silently default-constructs a bogus entry.
