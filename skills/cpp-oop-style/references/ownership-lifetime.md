# Ownership & Lifetime

How values live and die in archibate-style C++. The governing idea:

> **`}` is the greatest operator.** Resources are acquired in a constructor and
> released by scope exit. You should almost never write cleanup code.

## No raw `new` / `delete`

In application code, never use `new`, `delete`, `new T[]`, `delete[]`, `malloc`,
or `free`. The only exceptions are writing an allocator yourself, or stuck on
pre-C++11 without Boost.

| Need | Wrong | Right |
|---|---|---|
| One owned object | `T *p = new T(...)` | `auto p = std::make_unique<T>(...)` |
| One shared object | `shared_ptr<T> p(new T())` | `auto p = std::make_shared<T>(...)` |
| Dynamic array | `T *a = new T[n]` | `auto a = std::vector<T>(n)` |
| Dynamic array | `make_shared<T[]>(n)` | `auto a = std::vector<T>(n)` |

Smart pointers manage a **single** object. Arrays are `vector`'s job — it carries
`.size()` and real ownership semantics; `unique_ptr<T[]>` throws that away.

Never write `shared_ptr<T>(new T())` — the `make_shared` form is the rule since
C++11: one allocation instead of two, and exception-safe.

## Pointer vs pointee — the lawyer rule

`p` (the pointer) and `*p` (the object it points at) have **completely
independent lifetimes**. `p` is usually automatic storage on the stack; `*p` may
be dynamic. Destroying a raw pointer does **not** run the pointee's destructor.
Smart pointers exist precisely to tie the two together.

## References vs raw pointers for borrowing

A raw pointer leaves ~10 questions open: nullable? owned? an array? how is it
freed? Encode the answer in the **type** instead:

```cpp
Student &getStudent(std::string_view name);          // borrowed, non-null, single
std::unique_ptr<Student> makeStudent(std::string_view name);   // owned, non-null
std::optional<Student> findStudent(std::string_view name);     // nullable, owned
```

- **Borrowed, non-null →** reference `T &` (or `T const &` to read).
- **Borrowed, nullable →** raw pointer `T *` (used purely as a non-owning view;
  this is the right use of a raw pointer — injected collaborators included).
- **Owned, transfer →** `unique_ptr<T>`.
- **Owned, maybe-absent →** `optional<T>`.

Cross this with cardinality — for *many* elements:

- **Borrowed many →** `std::span<T>` (`span<T const>` to read).
- **Owned many →** `std::vector<T>`, or `std::vector<std::unique_ptr<T>>` when the
  elements are polymorphic or must keep stable addresses across reallocation.

The injectee never owns its collaborators; it borrows them. Ownership lives in
the composition root.

## RAII for C resources

Wrap any C handle so scope exit frees it — no manual `close`:

```cpp
auto file = std::unique_ptr<FILE, decltype(&fclose)>(fopen(p, "r"), fclose);
// same custom-deleter form on shared_ptr — but only when ownership is genuinely shared:
auto conn = std::shared_ptr<mysql_connection>(mysql_connect("..."), mysql_close);
```

For a process-lifetime singleton subsystem, returning a raw owning pointer that
is intentionally never deleted (the process reclaims it at exit) is acceptable —
it avoids `shared_ptr` churn. This is a deliberate exception, not license to leak.

## Rule of five

If you declare a destructor, you take responsibility for the other four special
members. For a non-copyable resource owner, delete them all:

```cpp
struct Res {
    ~Res();
    Res(Res &&) = delete;
    Res &operator=(Res &&) = delete;
    Res(Res const &) = delete;
    Res &operator=(Res const &) = delete;
};
```

Better: hold the resource in a `unique_ptr`/`vector`/RAII wrapper, define **no**
destructor, and let the compiler generate correct moves for free (rule of zero).

If you *do* hand-write a move constructor, it must leave the source in a defined,
do-nothing state — blank the handle so the moved-from destructor is a no-op,
otherwise you double-free:

```cpp
Res(Res &&o) noexcept : h(o.h) { o.h = {}; }   // source blanked
~Res() { if (h) lib_free(h); }                  // safe on a moved-from object
```

## Polymorphic bases

Any class with `virtual` functions needs `virtual ~T() = default;`. Without it,
`delete basePtr` skips the derived destructor and leaks its RAII members. Enable
`-Wnon-virtual-dtor` and `-Wdelete-non-virtual-dtor`. To block slicing on a
polymorphic base, also `T &operator=(T &&) = delete;`.

## Dangling temporaries

A temporary lives to the end of the **full expression** — one line. Binding it
directly to a `const &` extends it to the enclosing scope; binding it *through a
function return* does not:

```cpp
std::string const &ok = std::string("hi");              // extended — safe to end of block
std::string const &bad = identity(std::string("hi"));   // NOT extended — dangling
```

## Cheap moves & deferred init

- Wrap large objects in `unique_ptr`/`shared_ptr` so moving transfers only the
  pointer, not a deep copy.
- Use `optional<T>` for a member you cannot initialize at construction time
  instead of a "is-initialized" bool plus an invalid default.
- `std::move(x)` and `std::as_const(x)` **do nothing by themselves** — they are
  just casts to `T&&` / `T const&`. The actual move happens in the constructor or
  assignment that consumes the result; `std::move(v);` as a bare statement leaves
  `v` untouched.
- Prefer choosing the right ownership type over sprinkling `std::move`: a
  `unique_ptr` moves when you pass it, a `shared_ptr` copies freely, a
  value-semantic type with a `shared_ptr` member + explicit `clone()` gives
  cheap copy-on-write.

## When standard smart pointers doesn't apply

- Qt: follow `QObject *` tree-managed lifetime convention
- high-performance kernel: genuinely require page-aligned allocate (create custom RAII class for aligned buffers)
