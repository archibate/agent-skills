# Hot Paths, Abstraction, and Data-Oriented Polymorphism

## Contents

- [Find the actual hot path](#find-the-actual-hot-path)
- [Keep abstraction on the cold side](#keep-abstraction-on-the-cold-side)
- [Make the container polymorphic, not each element](#make-the-container-polymorphic-not-each-element)
- [Measure the full cost of dynamic polymorphism](#measure-the-full-cost-of-dynamic-polymorphism)
- [Dispatch by batch](#dispatch-by-batch)
- [Use data-oriented polymorphism](#use-data-oriented-polymorphism)
- [Design the boundary](#design-the-boundary)
- [Know when not to transform](#know-when-not-to-transform)

## Find the actual hot path

The 20/80 rule is a search heuristic, not a measured percentage. Use profiling
to find the small set of transformations that dominate the objective. Optimize
their dataflow and leave cold parsing, orchestration, error reporting, and setup
readable.

Do not remove a virtual call from a window-creation or configuration function
because it appears inside a loop in source. Measure its share of total time and
how often the loop runs in the real workload.

## Keep abstraction on the cold side

Abstract interfaces remain valuable for ownership, dependency injection, test
seams, backend selection, and stable module boundaries. Compose the system with
`$cpp-oop-style`, then hand a compact batch/data view to the selected kernel.

Good boundaries perform one coarse dispatch and much homogeneous work:

- choose backend/algorithm once, then process a span;
- build a command/data batch, then execute it;
- group active items by type/state, then run one kernel per group;
- convert external object-oriented records into a hot layout at a phase boundary;
- return data-only results without leaking ISA/device types.

Conversion is not free. Amortize it across enough operations or maintain the
hot representation as the authoritative state during the compute phase.

## Make the container polymorphic, not each element

For a measured hot iteration over a closed or currently known set of concrete
types, make storage carry the type distinction:

```cpp
struct AnimalPools {
    void add(Dog dog) { dogStorage.push_back(std::move(dog)); }
    void add(Cat cat) { catStorage.push_back(std::move(cat)); }

    std::span<Dog> dogs() { return dogStorage; }
    std::span<Cat> cats() { return catStorage; }

private:
    std::vector<Dog> dogStorage;
    std::vector<Cat> catStorage;
};
```

Run one statically typed loop over `dogs()` and another over `cats()`. This is
the primary data-oriented polymorphism pattern:

- `vector<Animal *>` scatters objects, chases pointers, dispatches virtually per
  element, and hides concrete layout from vectorization;
- `vector<variant<Dog, Cat>>` is contiguous but carries a tag per element, uses
  the largest alternative's size/alignment, and branches/visits through a mixed
  stream;
- `vector<Dog>` plus `vector<Cat>` stores each type densely, permits a distinct
  layout per type, and resolves dispatch once per segment instead of once per
  object.

The container owner is a value/resource type under `$cpp-oop-style`; `Dog` and
`Cat` can remain data or focused value types. Cold orchestration may still use an
`AnimalSystem` interface, or each type segment may implement one coarse
`updateBatch` virtual. Element loops remain statically typed.

This mirrors the segmented-storage idea in
[Boost.PolyCollection](https://www.boost.org/doc/libs/latest/libs/poly_collection/index.html),
which packs objects by concrete type and supports type-aware traversal. Prefer
explicit vectors when the type set and kernels are simple; use a segmented
polymorphic container or type-erased pool registry when open registration and a
unified container interface justify the machinery.

Type partitioning can change global order and complicate cross-type references,
insertion, removal, and serialization. Preserve identity with handles rather
than addresses, define whether order matters, and benchmark partition/maintenance
cost against the number of hot passes it enables.

## Measure the full cost of dynamic polymorphism

A virtual or function-pointer call itself may be small. The larger cost can be:

- inability to inline and specialize across the call;
- one branch target per element and poor prediction;
- pointer-chasing through separately allocated objects;
- mixed types causing divergent control flow;
- heterogeneous object sizes wasting cachelines;
- lost vectorization and alias information.

Conversely, if the callee performs substantial work or calls are predictable,
dispatch overhead may be irrelevant. LTO/devirtualization can remove calls, and
closed variants or templates can increase code size and instruction-cache
pressure. Inspect generated code and benchmark the full iteration.

## Dispatch by batch

Move selection outside the inner loop:

```text
select implementation/type bucket once
for each homogeneous batch:
    run contiguous kernel over batch
```

Options include:

- runtime ISA/backend function selected once by a factory;
- `std::variant` or enum dispatch at the batch boundary;
- template/concept specialization for a closed compile-time set;
- function tables indexed by tag, called once per bucket;
- sort/partition/compact by state before compute;
- mask-based SIMD when divergence is cheap and reordering is not allowed.

Do not replace open extensibility throughout the application with giant tag
switches. Confine closed-set/data-oriented dispatch to the performance domain.

## Use data-oriented polymorphism

Store each concrete type in its own dense vector, SoA segment, or AoSoA block.
Share fields across types only when a measured kernel benefits from a common
stream. Maintain stable IDs/handles rather than pointers when objects move during
compaction. Keep active indices, columns, and location maps aligned by explicit
invariants.

Choose among strategies:

- **Bucket by type:** best for expensive homogeneous kernels; costs partitioning
  and may reorder results.
- **Tagged SoA:** direct indexed access with an inner tag branch; useful when the
  type mix is predictable or partitioning costs more.
- **Predicated/masked vectors:** keeps order and handles mixed lanes; wastes work
  when masks are sparse or branches are very different.
- **Indirect function table:** flexible and compact, but still inhibits inlining
  and can be unpredictable per element.
- **Separate phase per capability:** avoids one cross-product hierarchy when
  different behaviors touch different fields.

Measure type distribution, churn, reorder cost, cache behavior, code size, and
downstream order requirements. There is no universally best data-oriented
polymorphism.

## Design the boundary

Use a small, type-rich configuration/result API and one ownership authority.
Typical shape:

- cold strategy/backend interface;
- data-only `KernelConfig`, `KernelInputView`, and `KernelResult`;
- factory or dispatcher returning a coarse callable/interface;
- scalar reference implementation;
- optimized implementations hidden in translation units or backend modules;
- benchmark and equivalence suite shared across implementations.

Avoid `std::function` inside a measured element loop. A template callable is
appropriate for inlinable hot policy, while virtual interfaces remain suitable
for coarse backend selection.

## Know when not to transform

Keep the existing abstraction when:

- profiling shows it is cold;
- per-call work dwarfs dispatch;
- the set is truly open and plugin extensibility is required;
- data conversion or bucketing costs more than it saves;
- the workload is tiny or latency-sensitive;
- optimized code would duplicate complex correctness logic without a reliable
  reference and benchmark.

Optimize the narrowest measured domain, not the entire object model. Report the
blast radius before a hot-layout rewrite changes public ownership, identity, or
ordering semantics.
