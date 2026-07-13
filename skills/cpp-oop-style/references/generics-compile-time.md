# Generics & Compile-Time Dispatch

When the set of types is known at compile time, resolve behavior at compile time —
no vtable, no heap, no runtime branch. The governing idea:

> **Duck typing with a checked contract.** A template already accepts any type
> that "quacks right"; `concept` / `requires` makes that contract explicit, and
> **overload resolution — not a type-switch — dispatches among types** at compile
> time, the way a vtable does at runtime.

This is the static twin of the polymorphism in `SKILL.md` — reach for it when the
type set is *closed and known*, and prefer a `virtual` interface when it is *open*.

## `if constexpr` — gate a step, don't switch on type

`if constexpr` decides a compile-time condition and **drops the dead branch before
compilation**, so it may legally hold code that wouldn't compile for this type. Its
honest uses are narrow:

- **Capability gating** — do an optional step only when the type supports it:

```cpp
template <class T>
void save(T const &x, Archive &ar) {
    ar.write(x.bytes());
    if constexpr (requires { x.checksum(); }) ar.write(x.checksum());   // only if present
}
```

- **Variadic recursion termination** — stop when the parameter pack is empty.

What it is **not** for: choosing among a fixed set of types.
`if constexpr (is_same_v<T, Dog>) … else if constexpr (is_same_v<T, Cat>) …` is
the compile-time twin of the `getType()` / `enum`-switch anti-pattern the main
skill rejects — every new type forces an edit to the chain. Dispatch on type with
**overloads** (below), not a type-switch.

## `requires` — does this expression compile?

`requires { expr; }` is a `constexpr bool`: `true` if `expr` would compile. Use it
to detect whether a type supports a member, then `if constexpr` on the result:

```cpp
template <class T>
void greet(T const &dog) {
    if constexpr (requires { dog.intro(); }) dog.intro();   // call it only if it exists
    dog.bark();
}
```

A `requires (T t) { ... }` introduces compile-time-only sample variables (no
runtime cost), and several statements all must compile:
`requires { ++it; --it; }` ≡ `requires { ++it; } and requires { --it; }`.

## `concept`-constrained overloads — the static twin of virtual dispatch

Hoist a recurring `requires` into a named `concept` (a `constexpr bool` variable
template): a type that satisfies it *is* that concept — duck typing with a name.
Then write **one overload per concept** and let overload resolution pick the
most-constrained match, exactly as a vtable picks the override at runtime — but at
compile time, with zero overhead:

```cpp
template <class It> concept Bidirectional = requires (It it) { ++it; --it; };
template <class It> concept RandomAccess  = Bidirectional<It>           // refines, so it subsumes
                                          and requires (It it, int n) { it += n; };

void advance(RandomAccess auto &it, int n)  { it += n; }                // more constrained → wins
void advance(Bidirectional auto &it, int n) { while (n-- > 0) ++it; }   // resolution dispatches
```

Adding a new iterator kind adds a new overload — it touches no existing one, the
same open/closed property the skill values in `virtual`. Constraining a parameter
also gives callers a clear error instead of a deep instantiation dump:

```cpp
void sort(RandomAccess auto first, RandomAccess auto last);   // C++20 constrained auto
template <RandomAccess It> void sort(It first, It last);      // equivalent long form
```

Prefer the standard `<concepts>` (`std::integral`, `std::ranges::range`, …) before
rolling your own.

## `std::variant` + `std::visit` — closed-set value polymorphism

When the type set is **fixed and known**, a `variant` gives polymorphism with
value semantics — no heap, no vtable, no `virtual ~T()`:

```cpp
using Shape = std::variant<Circle, Square, Triangle>;

double area(Shape const &s) {
    return std::visit([](auto const &x) { return x.area(); }, s);   // one generic lambda
}
```

For per-type branches, the `overloaded` helper turns several lambdas into one
visitor:

```cpp
template <class... Ts> struct overloaded : Ts... { using Ts::operator()...; };
template <class... Ts> overloaded(Ts...) -> overloaded<Ts...>;

std::visit(overloaded{
    [](Circle const &c)   { return draw(c); },
    [](Square const &s)   { return draw(s); },
    [](Triangle const &t) { return draw(t); },
}, shape);
```

Choose by openness: a **closed** set you control → `variant` (the alternatives
can't grow without editing the `using`); an **open** set extended by other modules
or plugins → a `virtual` interface (`SKILL.md` Compose / Visitor). `variant` also
wins when you want value copies and no allocation.

## Perfect forwarding & exact return types (advanced)

For a zero-overhead generic wrapper or factory, take `auto &&` (a forwarding
reference) and pass it on with `std::forward` so the value category (lvalue /
rvalue) is preserved — a copy isn't forced where a move was possible:

```cpp
auto logged(auto &&...args) {
    log("calling");
    return target(std::forward<decltype(args)>(args)...);   // preserve lvalue/rvalue
}
```

Use `decltype(auto)` (not plain `auto`, which decays) when a wrapper must return
*exactly* what the inner call returns, references included:

```cpp
decltype(auto) front(auto &c) { return c.front(); }   // returns T& / T const&, not a copy
```
