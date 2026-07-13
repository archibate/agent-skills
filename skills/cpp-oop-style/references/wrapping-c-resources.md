# Wrapping C Resource APIs

C libraries hand you opaque handles (`FILE*`, `cudaStream_t`, GL `GLuint`,
`sqlite3*`) and `int`/enum error codes. Wrap them so the rest of your code never
touches a raw handle, never checks an error code by hand, and never leaks.

For a **single** resource, the `unique_ptr` / `shared_ptr` custom-deleter form in
`ownership-lifetime.md` is enough. Reach for the idioms below when wrapping a
whole C **API surface** with many handle types and a pervasive error enum.

## 1. Move-only opaque handle template

One template owns any handle type: move-only, auto-releasing, implicitly
convertible back to the raw handle for passing into C calls.

```cpp
template <class H>
struct Handle {
    H h{};
    Handle() = default;
    explicit Handle(H h) noexcept : h(h) {}
    Handle(Handle const &) = delete;
    Handle &operator=(Handle const &) = delete;
    Handle(Handle &&o) noexcept : h(o.h) { o.h = {}; }
    Handle &operator=(Handle &&o) noexcept { std::swap(h, o.h); return *this; }
    H get() const noexcept { return h; }
    operator H() const noexcept { return h; }          // pass straight to C API
    explicit operator bool() const noexcept { return h != H{}; }
};
```

A concrete wrapper derives from it and supplies the destructor:

```cpp
struct Widget : Handle<widget_t> {
    using Handle::Handle;
    ~Widget() { if (*this) lib_destroy(get()); }
};
```

## 2. Custom `std::error_category` for the C error enum

Turn the library's error codes into first-class `std::error_code` values via an
allocation-free static-local category singleton:

```cpp
inline std::error_category const &libCategory() noexcept {
    static struct : std::error_category {
        char const *name() const noexcept override { return "mylib"; }
        std::string message(int ev) const override {
            return lib_strerror(static_cast<lib_err_t>(ev));
        }
    } cat;
    return cat;
}
inline std::error_code makeCode(lib_err_t e) noexcept {
    return {static_cast<int>(e), libCategory()};
}
```

## 3. Check-on-assign with `source_location`

A tiny checker turns every C call into one clean line that throws with the call
site baked in — no macro, zero overhead at the call site:

```cpp
struct Check {
    std::source_location loc;
    Check(std::source_location l = std::source_location::current()) : loc(l) {}
    void operator=(lib_err_t err) {
        if (err != LIB_SUCCESS) [[unlikely]]
            throw std::system_error(makeCode(err),
                std::string(loc.file_name()) + ":" + std::to_string(loc.line()));
    }
};
// call site:
Check{} = lib_do_thing(args);
```

Throwing here fits **acquisition and setup**, where a failed C call is
unrecoverable (per `error-handling.md`'s recoverable/unrecoverable split): the
throw stands in for a `terminate`, and call sites read as if they always succeed.
For a *recoverable* per-call failure, or a no-exceptions build, the same shape
returns an `expected` or logs and returns `false` instead — value-based stays the
default there.

## 4. `[[nodiscard]]` scope-bound bind guard

When a C API has paired bind/unbind (or lock/unlock) calls, return a move-only
guard that unbinds in its destructor. `[[nodiscard]]` stops callers from
dropping it on the floor:

```cpp
struct [[nodiscard]] BindGuard {
    handle_t h;
    explicit BindGuard(handle_t h) : h(h) { lib_bind(h); }
    BindGuard(BindGuard &&) = delete;
    ~BindGuard() { lib_unbind(h); }
};
struct Vao : Handle<handle_t> {
    BindGuard bind() const { return BindGuard{get()}; }
};
// usage — auto-unbinds at end of scope:
auto bound = vao.bind();
```

This is the canonical RAII-for-C-resource pattern (cf. `GLHandleImpl` in
parallel101/opengltutor's `check_gl.hpp` — the cleanest worked example).

## 5. Builder over flag-soup constructors

When creation takes a pile of int flags, a small builder gives named,
order-free, defaulted options (the type-rich rule applied to construction):

```cpp
struct Widget : Handle<widget_t> {
    using Handle::Handle;
    ~Widget() { if (*this) lib_destroy(get()); }
    struct Builder {
        int flags = 0;
        Builder &withOption(bool on = true) noexcept {
            flags = on ? (flags | FLAG_OPT) : (flags & ~FLAG_OPT);
            return *this;
        }
        Widget build() {
            widget_t w{};
            Check{} = lib_create(&w, flags);
            return Widget{w};
        }
    };
};
// usage:
auto w = Widget::Builder{}.withOption().build();
```

## 6. Named factories for sentinel states

When a handle has magic predefined values (a "default" / "per-thread" instance
that must NOT be destroyed), expose them as named factories and guard the
destructor — don't make callers remember the sentinels:

```cpp
struct Stream : Handle<stream_t> {
    using Handle::Handle;
    static Stream defaultStream() noexcept { return Stream{nullptr}; }
    static Stream perThread()     noexcept { return Stream{LIB_STREAM_PER_THREAD}; }
    ~Stream() {
        if (*this and get() != LIB_STREAM_PER_THREAD) lib_stream_destroy(get());
    }
};
```

## 7. Allocator policy for C allocators

Wrap a C allocator pair as an allocator type, translating its OOM code to
`std::bad_alloc` so it composes with standard containers:

```cpp
template <class T, class Arena>
struct Allocator : private Arena {
    using value_type = T;
    T *allocate(std::size_t n) {
        if (n > std::numeric_limits<std::size_t>::max() / sizeof(T))
            throw std::bad_array_new_length();
        void *p{};
        auto err = Arena::doAlloc(&p, n * sizeof(T));
        if (err == LIB_OOM) [[unlikely]] throw std::bad_alloc();
        Check{} = err;
        return static_cast<T *>(p);
    }
    void deallocate(T *p, std::size_t) noexcept { Arena::doFree(p); }
};
```

These idioms are distilled from parallel101/cppguidebook's `cudapp.cuh` (a
teaching-grade modern-C++ CUDA wrapper) and opengltutor's GL handle wrapper.
