# Undefined Behavior

Load this reference when writing or reviewing code involving pointer validity,
object lifetime, type punning, arithmetic boundaries, sequencing, library
preconditions, or shared mutable state, and when investigating suspected UB.

This is a practical checklist, not an exhaustive language catalogue. Its topic
inventory comes from parallel101's [undefined-behavior chapter](https://parallel101.github.io/cppguidebook/undef/);
the qualifications below follow the linked standards. Use the project's actual
language version; the baseline here is C++17–23, with later changes called out.

## Classify the behavior first

- **Undefined behavior:** the standard imposes no requirements on that execution.
  Establish the operation's preconditions before executing it; a later check
  cannot repair UB that has already happened.
- **Unspecified behavior:** several permitted outcomes exist; the implementation
  need not document its choice. Do not make correctness depend on one outcome.
- **Implementation-defined behavior:** the implementation must document its
  choice. State the platform dependency when relying on it.
- **Ill-formed code:** violates a language rule; it is a separate classification
  from runtime UB. Most such violations require a diagnostic, but some do not.

See the standard's [definitions](https://eel.is/c++draft/intro.defs).
Successful compilation, a debug assertion, or a passing run does not establish
defined behavior. Validate external input in release builds as well.

## Pointers, bounds, and lifetime

- Dereference only pointers to live objects and dereferenceable iterators.
  Null pointers, past-the-end iterators, and pointers to destroyed objects do
  not meet that contract. Calling a non-static member function also requires
  an appropriate live object; checking `this` inside it is too late.
- Keep pointer arithmetic within one array, including its one-past position;
  never dereference one-past. Subtraction requires pointers into the same array
  (including one-past) and a result representable in `std::ptrdiff_t`.
  Forming an out-of-bounds pointer can already be UB, before any access.
  See [pointer arithmetic](https://eel.is/c++draft/expr.add).
- Track invalidation after container growth, erasure, or replacement. Reacquire
  affected iterators, pointers, and references. A `span`, `string_view`, or
  reference capture does not keep its owner alive; see `ownership-lifetime.md`
  and `functors-callbacks.md` for ownership and capture design.
- Initialize scalar values before reading them. In C++17–23, reading an
  indeterminate `int` is UB. C++26 distinguishes erroneous values from
  indeterminate values; it does not make uninitialized reads acceptable.
  Special byte-propagation exceptions are not permission to compute with an
  uninitialized value. See [indeterminate values](https://eel.is/c++draft/basic.indet).
- Pair allocation and deallocation correctly, release once, and stop accessing
  an object after its lifetime ends. Use RAII to enforce this. Ordinary deletion
  of a derived object through a base pointer requires a virtual base destructor;
  otherwise it is UB, not merely a skipped destructor. The C++20 destroying-delete
  exception is a specialized lifetime protocol, not a substitute for the skill's
  virtual-destructor rule. See [delete](https://eel.is/c++draft/expr.delete#3).

## Types, alignment, and representation

- A cast does not establish alignment, object lifetime, or permission to access
  storage as another type. Prove all three before typed access to raw storage.
  Use checked downcasts at uncertain polymorphic boundaries; modifying an object
  originally defined `const` is UB. Follow the main skill's cast ladder.
- For representation access, C++ permits `char`, `unsigned char`, and `std::byte`;
  `signed char` is not a general aliasing exception. Corresponding signed and
  unsigned integer types may alias. Do not extrapolate these exceptions to
  arbitrary same-sized types. See [type accessibility](https://eel.is/c++draft/basic.lval).
- Reading an inactive union member is generally invalid; narrowly specified
  cases such as the common initial sequence of standard-layout struct members
  do not make union-based type punning portable. See [unions](https://eel.is/c++draft/class.union).
- Use `std::bit_cast` (C++20) for equal-sized trivially copyable representations,
  or `memcpy` into an existing suitable object. Neither validates arbitrary
  bytes as a value: invalid representations, notably for `bool` and pointers,
  remain a problem. Decode untrusted bytes into integer/byte fields and validate
  before constructing constrained values. See [bit_cast](https://eel.is/c++draft/bit.cast).

## Arithmetic and conversions

- Check signed arithmetic before performing it. Overflow in addition,
  subtraction, multiplication, or negation is UB; checking the result afterward
  is too late. Unsigned arithmetic wraps modulo its range, but narrow unsigned
  operands may first promote to signed `int`.
- Integer division and remainder require a nonzero divisor and a representable
  quotient. Both `INT_MIN / -1` and `INT_MIN % -1` are UB on two's-complement
  `int`. See [multiplicative operators](https://eel.is/c++draft/expr.mul).
- Shift counts must be nonnegative and less than the width of the **promoted**
  left operand. Prefer unsigned operands for bit manipulation. In C++17,
  signed left shift also restricts the value being shifted, and right shift of
  a negative value is implementation-defined. C++20 changed those signed-value
  rules; it retained the shift-count restriction. See
  [C++17 shifts](https://timsong-cpp.github.io/cppwp/n4659/expr.shift) and
  [C++20 shifts](https://timsong-cpp.github.io/cppwp/n4861/expr.shift).
- Floating-to-integer conversion requires the truncated value to be
  representable (conversion to `bool` has separate rules). Reject NaN, infinity,
  and out-of-range values before the cast; account for rounding when expressing
  integer bounds in floating point. Integral-to-integral narrowing is a
  different rule, not automatically UB. See [floating conversions](https://eel.is/c++draft/conv.fpint)
  and [integral conversions](https://eel.is/c++draft/conv.integral).

## Sequencing and function calls

Unsequenced conflicting accesses to the same scalar object cause UB, as in
`i++ + i++`. Merely leaving the order unspecified is different: since C++17,
`consume(i++, i++)` sequences one parameter initialization before the other,
without specifying which comes first. Assuming the increments do not overflow,
that call is not UB. Split expressions when the order matters:

```cpp
auto i = int{0};
auto const first = i++;
auto const second = i++;
consume(first, second); // deliberately passes 0, then 1
```

See [execution sequencing](https://eel.is/c++draft/intro.execution) and
[C++17 function calls](https://timsong-cpp.github.io/cppwp/n4659/expr.call).

Call function pointers only when non-null and call-compatible with the actual
function type; a cast cannot adapt an incompatible signature. Ordinary
value-returning functions must return a value or leave by another valid path
(such as throwing); flowing off the end is UB. `main` has an implicit zero
return, while coroutines have separate promise-dependent rules. See
[calls](https://eel.is/c++draft/expr.call) and [returns](https://eel.is/c++draft/stmt.return).

## Library preconditions

- Check indices against `size()`, not `capacity()`. `vector::operator[]` needs
  an existing element; `front()` and `back()` need a nonempty container.
  `at()` provides a checked alternative for indexed access. C++26 library
  hardening can diagnose some violations; it does not make them valid calls.
  See [container access](https://eel.is/c++draft/sequence.reqmts).
- Check an `optional` before dereferencing it. `value()` has a specified
  exception on absence; `operator*` requires an engaged value. See
  [optional observers](https://eel.is/c++draft/optional.observe).
- For `memcpy`, provide valid source/destination ranges with enough storage and
  no overlap; use `memmove` for overlapping ranges. A zero count does not grant
  permission to pass null pointers to these C library functions. See
  [C library arguments](https://www.sigbus.info/n1570#7.1.4) and
  [memory copying](https://www.sigbus.info/n1570#7.24.2).
- The one-argument `<cctype>` functions accept `EOF` or a value representable as
  `unsigned char`, not just ASCII 0–127. Convert a stored `char` through
  `unsigned char`; preserve an `int` input's `EOF` sentinel before conversion.
  See [C character handling](https://www.sigbus.info/n1570#7.4), incorporated by
  [C++ `<cctype>`](https://eel.is/c++draft/cctype.syn).

```cpp
auto const byte = char{'A'};
auto const alphabetic = std::isalpha(static_cast<unsigned char>(byte)) != 0;
```

## Concurrency

- A data race involves potentially concurrent conflicting accesses, at least
  one non-atomic, without the required happens-before ordering; it is UB.
  Protect shared state with a consistent locking or atomic protocol. `volatile`
  provides no thread synchronization. Atomic fields alone do not make a compound
  invariant atomic. See [data races](https://eel.is/c++draft/intro.races).
- Locking a non-recursive mutex already owned by the calling thread or unlocking
  a mutex the caller does not own violates its preconditions. By contrast, two
  threads waiting on each other's locks is a deadlock, not automatically UB.
  Use RAII locks and a consistent acquisition order or `std::scoped_lock` for
  acquiring multiple distinct mutexes. See [mutex requirements](https://eel.is/c++draft/thread.mutex.requirements.mutex.general).

## Evidence during debugging

### Local constexpr probes

For an individual high-risk function whose behavior you doubt, or a suspected
UB site you want to understand, use forced constant evaluation as a quick local
check. This suits pure computation or logic whose small I/O boundary can be
replaced with constexpr test inputs. Iterate in a temporary translation unit
with `-fsyntax-only`: edit, compile, inspect the diagnostic, and refine the case
without repeatedly starting the whole application under a sanitizer.

Call the original constexpr implementation when possible. Otherwise make a
temporary constexpr copy, preserving its types, arithmetic, control flow, and
relevant lifetime relationships; replace only the I/O boundary. Force evaluation
with a constexpr initializer, `static_assert`, or a C++20 `consteval` call.
Declaring a function `constexpr` alone does not force any call to be evaluated.

```cpp
#include <limits>

constexpr void ubCheck(int const shift) {
    auto const result = 1u << shift;
    (void)result;
}

static_assert((ubCheck(std::numeric_limits<unsigned>::digits), true)); // must fail to compile
```

Changing the count to `std::numeric_limits<unsigned>::digits - 1` gives a valid
control case. Keep the computation inside the evaluated call even when its
result is discarded, as in this void-returning probe.

Required constant evaluation rejects core-language UB on the evaluated path.
This gives a language-enforced check for the chosen inputs and tested body;
proving a whole input domain additionally requires exhaustive coverage or an
argument covering the remaining cases. Standard-library UB is not guaranteed
to be diagnosed. A compile failure can also mean an unsupported constexpr
operation or an evaluation limit: read the diagnostic before calling it UB.
See [constant-expression requirements](https://timsong-cpp.github.io/cppwp/n4861/expr.const#5).

Start with the project's language version. Newer standards allow more code in
constant evaluation and can make a temporary probe easier to build; label any
version change and check whether it changes the suspect operation's semantics
before applying that conclusion to an older-standard build.

### Integrated sanitizer checks

After resolving the local suspicion, retain a dedicated sanitizer test with
real I/O and dependencies connected. It exercises integration, ownership, and
concurrency behavior outside the constexpr probe and its mocked boundary.

Use warnings and standard-library debug checks from the main skill, and select
sanitizers for the suspected category: [UBSan](https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html)
for supported UB checks, [ASan](https://clang.llvm.org/docs/AddressSanitizer.html)
for memory errors, and a separate [TSan](https://clang.llvm.org/docs/ThreadSanitizer.html)
build for data races. A clean run covers only exercised paths and implemented
checks; it does not prove absence of UB. Establish the language/library contract
and the input or lifetime invariant in addition to testing.
