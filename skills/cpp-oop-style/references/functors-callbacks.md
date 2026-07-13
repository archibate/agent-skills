# Functors, Lambdas & Callbacks

When behavior is the parameter. Choose the mechanism by *where the callback
lives*, not by habit.

## Template `Func` vs `std::function` vs virtual

Three ways to pass behavior — pick by need:

```cpp
// Hot path: compile-time dispatch, inlinable, zero overhead.
template <class Func>
void forEach(std::span<int> data, Func f) { for (auto x : data) f(x); }
// equivalently, C++20:
void forEach(std::span<int> data, auto f);

// Stored / runtime-selected: type-erased, flexible, small-object-optimized.
struct Widget { std::function<void(Event)> handler; };
```

- **Template `Func` / `auto` param** — when the callable is known at the call
  site and performance matters. No allocation, fully inlinable.
- **`std::function`** — when the callback is *stored* or *chosen at runtime*. It
  has small-object optimization, so small/stateless closures avoid the heap.
- **Virtual interface** — when the callback is one method of a larger object with
  its own identity and several related operations. For a bare callback,
  `std::function` beats `unique_ptr<AbstractCallback>` (which always heap-allocates).
- **Hand-rolled type erasure** — when you need *several* operations
  (`speak` + `load` + `clone`) over **unrelated value types you don't own and
  can't make inherit**. Reach for it only when one `std::function` signature
  isn't enough and a shared base isn't possible; load `type-erasure.md` for the
  design and implementation.

So: don't reach for an abstract class to pass a single function — that's what
functors are for. Reach for it (or type erasure) when behavior has *identity* and
*multiple operations*.

## Lambdas over `std::bind`

`std::bind` is historical baggage — placeholder counting, opaque capture, breaks
on overloads. Use a lambda:

```cpp
// Bad
auto f = std::bind(hello, 2, std::placeholders::_1);
// Good
auto f = [b](int a) { return hello(b, a); };
```

The only tolerable survivor is `std::bind_front` for binding `this` to a member
function — and even there a lambda is clearer.

## Lambdas over named functor classes

For transient behavior, a lambda captures context inline; a named functor class
forces a separate declaration far from its use. Reserve named functors for a
reusable callable that genuinely deserves a name and its own home.

## Capture & lifetime

Mental model: **a closure is an anonymous struct** whose members are the captured
variables, with an `operator()`. That makes lifetime obvious.

```cpp
int x = 10;
auto lam = [x]() { return x; };
// the compiler effectively writes:
struct __Lambda { int x; int operator()() const { return x; } };
```

- Default to **value capture `[=]`** until you fully understand lifetime; then
  switch to selective reference capture.
- **Never `[&]` if the lambda can outlive the captured variables** — a stored
  `std::function` capturing a local by reference dangles the moment that scope
  ends.
- `mutable` lets the closure write back to a *value-captured* copy; the original
  is untouched.
- For `std::thread`, pass a lambda, not `function-pointer + args` — make
  reference-vs-value capture explicit: `std::thread([&x]{ f(x); })`.

## Lifetime-safe callbacks (signals / slots)

When a callback is a member function of an object that may die before the emitter
fires, don't store a raw `this` — bind through a `weak_ptr` so dead listeners
auto-drop:

```cpp
signal.connect(weak_from_this(), &Mine::onInput);   // skipped/erased once expired
```

Two refinements:

- **Let a slot self-unregister by return value** — `enum class CallbackResult :
  std::uint8_t { Keep, Erase }` — so `emit` removes it, instead of manual disconnect
  bookkeeping. (Tag-dispatch a one-shot / n-shot variant the same way.)
- **Store non-copyable closures in `std::move_only_function`** (C++23) rather than
  `std::function`, which requires the target be copyable. Select via
  `__cpp_lib_move_only_function`.

Hide the member-pointer call syntax behind `connect(obj, &Cls::method)` — callers
should never write `((*p).*pmf)(args...)`.

## Behavior injection over enum-switch

To vary an algorithm, inject the behavior — don't branch on an enum. This keeps
the function open for extension, closed for modification:

```cpp
// Bad: a new mode means editing this function.
int reduce(std::vector<int> const &v, Mode mode);
// Good: pass the operation.
int reduce(std::vector<int> const &v, auto op);
```

This is the functional twin of the State/Strategy patterns in the main skill:
small, local behavior → functor; behavior with its own state and several
operations → a Strategy object behind an interface.

## Immediately-invoked lambda

Use an IIFE to scope early-return logic or to initialize a `const` that needs a
few statements:

```cpp
auto const config = [&] {
    if (hasOverride) return loadOverride();
    return loadDefault();
}();
```
