# Data Layout and Memory

## Contents

- [Design around transformations](#design-around-transformations)
- [Choose AoS, SoA, or AoSoA](#choose-aos-soa-or-aosoa)
- [Vectorize across records, not components](#vectorize-across-records-not-components)
- [Encapsulate SoA column invariants](#encapsulate-soa-column-invariants)
- [Batch independent irregular queries](#batch-independent-irregular-queries)
- [Split hot and cold data](#split-hot-and-cold-data)
- [Choose the minimum sufficient representation](#choose-the-minimum-sufficient-representation)
- [Pack and align deliberately](#pack-and-align-deliberately)
- [Reduce footprint](#reduce-footprint)
- [Recompute cheap values instead of loading them](#recompute-cheap-values-instead-of-loading-them)
- [Specialize structured sparse operators](#specialize-structured-sparse-operators)
- [Choose sparse representations](#choose-sparse-representations)
- [Regularize sparse traversal](#regularize-sparse-traversal)
- [Transform loops for locality](#transform-loops-for-locality)
- [Flatten pointer trees and follow the stride vector](#flatten-pointer-trees-and-follow-the-stride-vector)
- [Prefetch computed future addresses](#prefetch-computed-future-addresses)
- [Recognize when cache becomes a write tax](#recognize-when-cache-becomes-a-write-tax)
- [Tile and fuse](#tile-and-fuse)
- [Tile in space and time](#tile-in-space-and-time)
- [Use Morton order selectively](#use-morton-order-selectively)

## Design around transformations

Data-oriented design begins with the operations performed over many elements:

- Which fields are read or written together?
- In what order are elements visited?
- How many times is each value reused, and at what distance?
- Which subset is active?
- Which fields vary by type or phase?
- What unit should be loaded, vectorized, scheduled, and synchronized?

Draw the dataflow before choosing types. Optimize the bytes and dependency graph
needed by the dominant transformation, while keeping conversion at cold
boundaries where possible.

## Choose AoS, SoA, or AoSoA

**Array of Structures (AoS)** keeps all fields of one object adjacent. Prefer it
when most operations consume whole records, record-level insertion/removal is
important, or an external ABI fixes the layout.

**Structure of Arrays (SoA)** keeps each field in its own contiguous stream.
Prefer it when kernels touch a subset of fields, each field is processed in
bulk, vector lanes should load one attribute, or fields have different update
frequencies.

**Array of Structures of Arrays (AoSoA)** divides elements into fixed blocks,
with SoA fields within each block. Prefer it when blocks are the units of cache
reuse, SIMD, tasks, sparse activation, or device transfer.

Do not select by slogan. Compute useful bytes per cacheline for the actual
kernel. A forced global SoA conversion can cost more than register shuffles over
an externally required AoS stream. AoSoA block size is a tuning parameter based
on SIMD width, cache working set, halo, and scheduling granularity—not a magic
4 KiB or 1024-element constant.

Represent the layout behind a batch view or container boundary so the rest of
the program does not depend on every storage detail.

The bundled `parallel101/simdtutor/customers/parallel_multiply_uint8/` is a
useful counterexample to dogmatic conversion: its fastest staged variants keep
the externally useful packed RGB layout and reshape only the tiny mask stream in
registers. Convert the cheaper side of the operation when that produces the
same contiguous compute shape.

## Vectorize across records, not components

For a three-component value, packing one record as `[x, y, z, unused]` in an SSE
register vectorizes *within* one object. It wastes one lane, dot products require
a horizontal reduction, and cross products require component shuffles. Wider
AVX registers do not automatically improve this representation because object
boundaries and lane-local operations complicate packing multiple triplets.

Packet SoA/AoSoA instead vectorizes *across* independent records. For four
records, three SSE registers hold:

```text
x = [x0 x1 x2 x3]
y = [y0 y1 y2 y3]
z = [z0 z1 z2 z3]
```

Two such packets produce four dot products using vertical operations:

```text
dot = ax * bx + ay * by + az * bz
```

They produce four cross products without component-lane shuffles:

```text
cx = ay * bz - az * by
cy = az * bx - ax * bz
cz = ax * by - ay * bx
```

Every lane performs the same component operation for a different record. The
same source shape extends naturally to eight AVX2 lanes, sixteen AVX-512 lanes,
or another backend's native width. It uses all lanes and exposes ordinary
vertical multiply/add/FMA scheduling instead of repeated horizontal work.

Use full SoA for long homogeneous streams or AoSoA when packets are also cache,
task, sparse-activation, or transfer units. The bundled
`parallel101/course/04/6_structs/02_vec3_simd_fail` through `07_vec3_aosoa` and
`08_benchmark/` form the teaching progression from three-float AoS, through
padding/alignment, to component streams and blocked packets.

This is a throughput transformation across many records, not necessarily a
single-vector latency win. Account for three live component registers per
packet—and six inputs plus three outputs for a cross product—along with tails,
masked/padded inactive lanes, gather/scatter at arbitrary record access, and
conversion at AoS APIs. If most operations consume one whole record or the
dataset is tiny, AoS or register-local transposition may remain preferable.

## Encapsulate SoA column invariants

A SoA is one logical sequence represented by several physical vectors. Give one
value/resource owner exclusive authority over structural mutation so every
column always describes the same set of records:

```cpp
struct DogColumns {
    std::span<Position> positions;
    std::span<Velocity> velocities;
    std::span<float> health;
};

struct Dogs {
    std::size_t size() const;
    DogColumns columns();
    void push(DogData dog);
    void eraseSwap(std::size_t index);

private:
    std::vector<Position> positions;
    std::vector<Velocity> velocities;
    std::vector<float> health;
};
```

The representation invariant is:

```text
positions.size() == velocities.size() == health.size()
```

Maintain it inside every structural operation:

- reserve or prepare all columns before committing an insertion, with rollback
  or no-fail commit semantics after the first size change;
- erase, swap, compact, reorder, and deserialize every column with the same index
  permutation;
- expose spans/views for hot element mutation, never independently resizable
  column containers;
- validate equal lengths after construction, loading, exceptional paths, and in
  debug assertions at mutation boundaries;
- represent genuinely optional fields with an explicit bitmap, side segment, or
  separate archetype rather than mismatched column lengths.

The view is a data class; the owner earns methods and private storage because it
enforces one invariant. This preserves `$cpp-oop-style` while giving kernels
flat, alias-auditable homogeneous spans. Different concrete-type pools can each
own their own SoA/AoSoA representation without coupling their record counts.

## Batch independent irregular queries

When one query is internally serial or irregular, vectorize across several
independent queries. A packet of `Xs[]` and `Ys[]` can evaluate interpolation
weights vertically, then gather each query's scattered stencil samples. This is
the same “lanes are records” principle applied to lookup-heavy work; sorting or
tiling queries may further improve gather locality.

`parallel101/simdtutor/customers/issue4_getsubpixelvalue/` is correction material
for this design. It changes AoS coordinate pairs into separate query streams and
sketches four-query AVX2 gathers, but the old scalar version drops the y-weight,
the SIMD polynomial has sign errors, its path is disabled, and integer-only test
coordinates conceal the coefficient defects. Build a corrected scalar oracle,
test fractional/negative/boundary coordinates and gather indices, then benchmark
gather versus scalar or locality-bucketed queries before claiming a win.

## Split hot and cold data

Move rarely used metadata, strings, diagnostics, ownership links, and exceptional
state away from the streaming record. Keep hot arrays dense and homogeneous.

Common forms:

- hot structure plus cold side table indexed by stable ID;
- active-index list over a larger backing store;
- type/tag array plus per-type payload pools;
- compact current-step state plus archival state elsewhere.

Splitting is useful only when the hot kernel avoids fetching the cold side. An
extra indirection that is followed for every element is not a hot/cold split.

## Choose the minimum sufficient representation

Choose the smallest representation that preserves the required domain states,
numeric range and precision, and extensibility. Normalize descriptive boundary
data once: use a compact enum or ID for domain categories, bits for independent
flags, and interned IDs for repeated open-set names. Keep text and descriptive
metadata on the cold side instead of carrying them through the kernel.

A string such as `QString` is appropriate at a GUI, file, or configuration
boundary, but not as a material-type tag carried through a hot FEM kernel. Parse
it once into an `enum class` for a fixed closed set or a compact `MaterialId`
for a registry.

Apply the same principle to numeric storage, but treat narrowing as a numerical
contract: compare `double`, `float`, BF16/FP16, fixed point, and small integers
against required range and error. Minimum sufficient does not mean blindly
choosing the smallest built-in type. Read `numerics-and-quantization.md` for the
numeric case.

## Pack and align deliberately

Inspect `sizeof`, `alignof`, member offsets, allocation alignment, and array
stride. Reorder fields to reduce padding when ABI permits. Use exact-width types
when width is part of the representation, not as a universal style rule.

Alignment has distinct purposes:

- satisfy the language and ISA's legal alignment;
- enable aligned vector accesses when they measurably help;
- place blocks on cache/page boundaries for predictable traversal;
- isolate independently written synchronization state to prevent false sharing.

Over-alignment can increase stride, footprint, cache/TLB pressure, and allocator
cost. `alignas(64)` is not portable proof of a cacheline; use the platform's
destructive-interference size when available or a measured/configured value.

Never parse packed external bytes by casting them to a C++ structure. Alignment,
object lifetime, aliasing, padding, and endianness still apply.

## Reduce footprint

Smaller representations can improve performance even when conversion requires
extra instructions, because more useful data fits in caches and fewer bytes
cross memory links.

Consider:

- narrowing indices or values after proving range;
- bitsets or bit packing for flags and small enums;
- dictionary/interned shared data;
- relative offsets instead of pointers when the range permits;
- eliminating per-element heap allocations and node metadata;
- implicit coordinates or defaults instead of stored repetition;
- compression by block when decompression is cheaper than traffic.

Account for metadata and random-access cost. A theoretically compact encoding
can lose if every access requires unpredictable lookup or scalar unpacking.

`parallel101/simdtutor/foundation/radixsort/radix_sort.cpp` supplies a structural
cost-model progression: pre-count to allocate once, flatten nested buckets,
swap input/output buffers between passes instead of copying back, then trade
fewer wider-radix passes against a much larger histogram working set. Later
variants privatize histograms by thread and merge phases. The corpus has a timing
harness but no pinned results, so reproduce the experiment rather than claiming
a ranking.

Read `numerics-and-quantization.md` before reducing numeric precision.

## Recompute cheap values instead of loading them

Do not materialize a coefficient, coordinate, weight, or transform merely because
it is reused. In a memory-bound kernel, on-the-fly computation can consume idle
arithmetic capacity while removing an input stream, shrinking the working set,
and avoiding random-load latency. Use a level-specific break-even model:

```text
compute_ops / effective_compute_rate < avoided_bytes / effective_memory_rate
```

For unpredictable accesses, also model miss latency and available memory-level
parallelism. Count address generation, conversion, and approximation error on the
compute side; count coefficient values, indices, cachelines, and TLB misses on
the load side. Confirm the trade with counters because recomputation can move the
kernel from memory-bound to compute-bound.

A LUT wins only when its saved computation outweighs its actual access cost. A
small predictable table resident in registers or L1/L2 is the favorable case;
a large or randomly indexed LUT can be slower than a vectorizable analytical
expression. Benchmark full computation, a polynomial/reciprocal approximation,
and lookup across the production working-set and index distributions.

## Specialize structured sparse operators

Represent the known operator, not an abstract matrix. A finite-difference heat
operator may be described algebraically as a matrix while each row actually
touches a fixed 3-, 5-, or 7-point neighborhood. Prefer, in order of increasing
generality:

1. a matrix-free stencil whose constant or analytical coefficients are formed in
   registers and applied directly to neighboring values;
2. DIA/banded storage with `K x N` coefficient arrays and fixed diagonal offsets
   when the `K` coefficients vary by row;
3. ELL/SELL-like fixed-width value and column arrays when each row has bounded
   but less regular structure;
4. CSR when row lengths and column locations genuinely require general metadata.

For a tridiagonal operator, three row-varying diagonals need roughly `3N` values,
not `N^2`; fixed analytical diagonals need no per-row coefficient storage at all.
The hot loop becomes adjacent loads plus a short FMA chain, without CSR row
offsets, column indices, or indirect gathers. Handle boundaries separately so the
interior remains branch-free and vectorizable.

`parallel101/course/10/00/00.cpp` starts from the fixed `[-1, 2, -1]`
tridiagonal Laplacian and `10.cpp` reaches CSR-like storage. Continue that lesson:
the structure is known strongly enough to use DIA or apply the expression
directly. `07/10_rbgs/01/main.cpp` similarly applies a two-dimensional red-black
Gauss-Seidel neighbor stencil without constructing a matrix. Preserve its
in-place phase dependencies; use red-black coloring, wavefronts, or another
proven schedule rather than treating it as an independent Jacobi pass.

Keep generic CSR/AMG paths for genuinely unstructured or coarse operators, but
dispatch structured fine-grid levels to specialized kernels when their invariant
is explicit and tested. Compare total bytes, useful FLOPs, setup, convergence,
and end-to-end solve time—not SpMV time alone.

## Choose sparse representations

Choose from occupancy and access pattern, not from the word "sparse":

- dense array/bitset for high occupancy or cheap scans;
- sorted active indices for iteration and binary search;
- COO for construction and append-heavy workflows;
- CSR/CSC for repeated row/column traversal and SpMV-like kernels;
- DIA/banded or matrix-free stencils for fixed diagonal/neighborhood structure;
- ELL/SELL-like storage for bounded nonzeros per row and regular SIMD/SIMT work;
- blocked CSR or block-sparse tiles when nonzeros cluster;
- hash table for dynamic random lookup;
- hierarchical dense/hash/pointer grids for spatially clustered occupancy.

Model value bytes, index bytes, row/block metadata, occupancy, construction cost,
lookup pattern, and load balance. Compact or reorder sparse work into homogeneous
batches when it reduces divergence and improves locality. Read
`ragged-topology.md` for variable-length adjacency, mesh faces, and flat buckets.

## Regularize sparse traversal

Sparse speed comes from regularizing the hot traversal, not merely omitting
zeros. The bundled `parallel101/course/10/00/` progression evolves the same
Laplacian operation from infeasible dense storage through ordered maps, flat COO,
per-row vectors, and finally CSR-like value/index streams plus row offsets.

Each stage removes a different cost: zero storage/work, tree lookup and pointer
chasing, tuple traversal, then per-row allocation. The final read-mostly kernel
walks compact sequential arrays. Retain the shared correctness oracle when
comparing stages. CSR is not a universal endpoint: construction, insertion,
random column lookup, and imbalanced rows may favor COO, blocked sparse formats,
hashing, or a hybrid build/finalize representation.

## Transform loops for locality

Before manual prefetching:

- place the contiguous dimension in the innermost loop;
- interchange loops when dependencies permit;
- replace pointer-chasing with flat indexed traversal;
- separate unpredictable sparse discovery from dense compute;
- hoist invariant loads and conversions;
- split a pass when fusion increases the live set or blocks vectorization;
- fuse passes when it removes intermediate traffic without inflating working set.

Software prefetch helps only for predictable future addresses with enough lead
time and computation to overlap latency. It can waste bandwidth and cache space.
Non-temporal stores suit large streaming writes that will not be read soon; they
are not a generic faster store.

## Flatten pointer trees and follow the stride vector

`parallel101/course/07/06_ndarray/01` replaces a three-level nested-vector tree
with one flat allocation, removing hundreds of thousands of small allocations
and pointer links. `02` then forms a four-way experiment: two loop orders against
two physical dimension orders. The reusable rule is exact—make the innermost loop
advance the unit-stride dimension declared by the layout.

An inlined ndarray abstraction can preserve this shape while adding bounds,
alignment, and halo policy. Document dimension order and strides, prove index
overflow and halo bounds, test non-power-of-two extents, and inspect generated
address arithmetic. The `03` blur benchmark protects the wrong output from
dead-store elimination, so repair its measurement before using its timings.

## Prefetch computed future addresses

“Randomly addressed” is not always “unpredictable.” In
`parallel101/course/07/03_prefetch/04/main.cpp`, the address generator is
deterministic even though its output is nonsequential. The loop computes the
address for a future iteration, prefetches that cacheline, performs intervening
independent work, then consumes the current address. This forms a software
pipeline across miss latency.

Tune lead distance from measured latency and work per iteration. Too little lead
arrives late; too much consumes miss-tracking resources and bandwidth or evicts
useful data. Ensure the prefetched address is legal, compare against hardware
prefetch behavior, and test production index distributions. The progression has
side-by-side benchmarks but no pinned result table, so treat it as a hypothesis
generator. Validate benefits with actual metric improvement.

## Recognize when cache becomes a write tax

`parallel101/course/07/03_prefetch/05` through `07` use a 512 MiB output against
the noted 32 KiB L1, 256 KiB L2, and 12 MiB L3. For a cold complete overwrite of
a common 64-byte x86 cacheline, model the first-order traffic:

```text
temporal write allocate:  64 B RFO read + 64 B dirty writeback
non-temporal full line:                        64 B output
```

Thus cached stores can transfer roughly twice the useful output and pollute cache;
partial-line writes can be worse. Cache is valuable when output is reused soon,
but becomes a tax for complete write-once streams beyond useful cache capacity.
Sweep sizes across L1, L2, LLC, and memory to find that crossover.

Compare three write policies on every target:

1. ordinary temporal stores;
2. an aligned, unmasked, full-cacheline temporal store where the ISA permits it;
3. explicit non-temporal/streaming stores covering complete cachelines.

A 64-byte-aligned, unmasked 512-bit AVX-512 temporal store presents one complete
cacheline at once. Some processors can acquire ownership without fetching old
data while retaining the new line in cache. Pre-collect one line in a ZMM register
when useful, but treat the effect as a measured microarchitecture optimization,
not an AVX-512 guarantee. Masked or misaligned stores lose the complete-line
proof; handle prefix and tail separately.

SSE/AVX store sequences may be recognized opportunistically, whereas explicit
non-temporal intrinsics provide the cache-bypassing hint at every vector width.
Temporal policy and vector width are independent; `MOVDIR64B` is a separate
contract. For non-temporal output, require aligned complete lines, avoid competing
writers, and fence at the visibility boundary. Immediate reads favor cached
output and are the essential counterexample.

Measure elapsed time, RFOs, dirty writebacks, and memory-controller traffic for
all three policies. The course examples require repair before reuse: fix
float/int pointer punning and alignment, add the completion fence, and compare
equal work rather than the skipped-write variant.

## Tile and fuse

Choose a tile from the bytes simultaneously live across inputs, outputs, halos,
temporaries, threads, and vector lanes. Benchmark around the estimate.

Spatial tiling reuses nearby values. Temporal tiling or kernel fusion reuses
intermediate values across stages or timesteps before eviction. Both require:

- explicit dependency and halo analysis;
- boundary/tail handling;
- a reference result;
- awareness of increased register/cache pressure;
- parallel ownership rules that prevent races and false sharing.

Fusion can reduce memory traffic but harm modularity, vectorization, code size,
or occupancy. Fission can improve homogeneous control flow and lower live state.
Measure the resulting bottleneck rather than maximizing fusion depth.

Cache-oblivious divide-and-conquer avoids one fixed tile size and can provide
multi-level locality. It does not remove recursion, cutoff, layout, or parallel
grain decisions. Prefer it when the recursive decomposition matches the
algorithm; prefer cache-aware blocking when hardware and workload are fixed and
tunable.

## Tile in space and time

For iterative stencils, fuse timesteps rather than merely adjacent statements.
`parallel101/course/07/04_fusion/01` through `05` progress from whole-array
Jacobi passes to algebraically paired steps, then load a spatial tile plus halo
into scratch and compute many timesteps while it remains resident. This trades
redundant halo arithmetic for far fewer streams over the 256 MiB arrays and
fewer global barriers.

Derive halo width from temporal depth and dependency radius; verify boundary
cells and partial tiles independently. Count scratch per worker, redundant halo
work, changed floating-point association, and write reuse before using
non-temporal stores. Tile depth and width are coupled tuning parameters, not
constants to copy. The examples contain timing hooks and a residual check but no
pinned timing table, so measure the current machine.

## Use Morton order selectively

Morton/Z-order interleaves coordinate bits so nearby multidimensional tiles are
often nearby in one-dimensional order. It can improve hierarchical traversal,
sparse spatial locality, or scheduling of tiles across cache levels.

Costs include encode/decode, awkward neighbors, boundary padding, reduced
contiguous SIMD spans, and mismatch with row/column-major libraries. Often the
best compromise is conventional contiguous storage within a tile and Morton
ordering only between tiles. Compare it with simple blocked row-major traversal.

`parallel101/course/07/08_matrix/01` demonstrates that compromise with ordinary
contiguous storage inside 64x64 tiles and Morton order between tiles. Do not copy
its streamed-transpose variants as evidence: their scalar stream-store loop does
not implement the advertised four-element write. Teach and remeasure only the
ordinary, tiled, and Morton traversal mechanisms.
