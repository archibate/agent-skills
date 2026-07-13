# Parallelism and Pipelines

## Contents

- [Choose the unit of parallel work](#choose-the-unit-of-parallel-work)
- [Set the degree of parallelism](#set-the-degree-of-parallelism)
- [Expose parallel span without multiplying traffic](#expose-parallel-span-without-multiplying-traffic)
- [Select scheduling by workload](#select-scheduling-by-workload)
- [Bound recursive parallelism with a serial cutoff](#bound-recursive-parallelism-with-a-serial-cutoff)
- [Use TLS reduction and scratch](#use-tls-reduction-and-scratch)
- [Overallocate locally, compact, then publish once](#overallocate-locally-compact-then-publish-once)
- [Choose append or scan-based stream compaction](#choose-append-or-scan-based-stream-compaction)
- [Build flat grid buckets with count scan scatter](#build-flat-grid-buckets-with-count-scan-scatter)
- [Prevent false sharing](#prevent-false-sharing)
- [Choose queue semantics](#choose-queue-semantics)
- [Amortize coherence with cached cursors and batches](#amortize-coherence-with-cached-cursors-and-batches)
- [Design bounded pipelines](#design-bounded-pipelines)
- [Use tokens as a throughput and memory control](#use-tokens-as-a-throughput-and-memory-control)
- [Treat a future as a dependency handle](#treat-a-future-as-a-dependency-handle)
- [Launch asynchronously with a dependency model](#launch-asynchronously-with-a-dependency-model)

## Choose the unit of parallel work

Parallelize chunks, tiles, rows, blocks, subtrees, or batches—not individual
cheap operations. Each task must amortize scheduling, queueing, synchronization,
cache warmup, and result publication.

Estimate useful time per task and sweep grain size. Too-fine tasks spend time in
the scheduler; too-coarse tasks reduce load balance and available parallelism.
Create enough ready tasks to occupy workers through imbalance, but not millions
of tiny tasks with large metadata and cache footprints.

Respect locality when decomposing. A scheduler cannot recover data reuse that
the task graph discarded.

## Set the degree of parallelism

More workers help only while there is independent work and an unsaturated
resource. Sweep thread count and record:

- throughput, latency, and efficiency;
- memory bandwidth and cache misses;
- CPU utilization and migrations;
- lock/atomic/barrier time;
- task stealing and imbalance;
- NUMA allocation and remote access;
- memory multiplied by per-thread scratch.

Compute-heavy kernels can scale to more cores than streaming memory-bound
kernels. SMT may hide latency or contend for the same execution resources.
Nested runtimes can oversubscribe the machine; establish one owner for thread
budgets and compose libraries through arenas/executors when possible.

For NUMA systems, place data by the threads that use it, partition ownership,
and measure remote traffic. First-touch behavior is platform-specific, not a
portable allocation guarantee.

## Expose parallel span without multiplying traffic

Use the slogan “compute can be embarrassingly parallel; memory bandwidth is a
shared budget.” Independent arithmetic units multiply with cores, but workers on
one socket usually contend for the same cache hierarchy, coherence fabric, and
memory channels. A rough lower bound is:

```text
time(p) >= max(work / (p * computeRate), span / computeRate,
               transferredBytes / sharedBandwidth) + overhead(p)
```

Parallelizing a memcpy-like stream may help one core generate enough outstanding
requests to reach the bandwidth knee. Beyond that knee, more threads merely
divide a saturated resource and add launch, cache, TLB, and coherence costs.
Small or cache-resident copies have different limits. NUMA and multi-node systems
add independent memory controllers or links, so partition local data and use one
bandwidth budget per locality domain rather than applying a socket-wide slogan.

Increase the *available parallelism* `work / span`, not merely the worker count.
Batch independent items, split independent tiles, use several accumulators, and
replace a serial recurrence with an associative tree only when the semantic
contract permits it. Then stop adding workers when compute occupancy, bandwidth,
task supply, or another shared resource saturates.

Prefix scan is the canonical example. A serial scan has Theta(n) work and
Theta(n) span. A work-efficient blocked/tree scan retains Theta(n) total work
up to constants while reaching `O(n/p + log p)` time on `p` processors; a
Hillis–Steele-style scan instead spends Theta(n log n) work to expose Theta(log n)
span. Real implementations may also reread input or invoke a range body in
preview and final passes. Parallel time can still win when the reduced critical
path repays that work and traffic, especially on wide accelerators, but a trivial
CPU scan can hit shared bandwidth first.

Study `parallel101/course/06/02_reduce/08` as a TBB scan experiment and
`06/07_filter/10` as scan-based compaction, then measure work, passes, bytes, and
thread scaling. Blelloch's
[prefix-sum treatment](https://www.cs.cmu.edu/~guyb/papers/Ble93.pdf) derives the
`O(n/p + log p)` family; do not describe every parallel scan as asymptotically
work-inefficient.

## Select scheduling by workload

- **Static partitioning:** lowest scheduler overhead and predictable locality;
  use for uniform dense loops.
- **Dynamic chunks:** adapt to moderate variable work at additional queue cost.
- **Guided partitioning:** begin coarse and refine toward the end.
- **Affinity partitioning:** favor reuse across repeated parallel calls.
- **Work stealing:** strong for irregular recursive/task graphs where local
  deques preserve common locality and idle workers steal larger remaining work.

A work-stealing queue is not a generic replacement for a dense-loop partition.
It trades determinism and some locality for load balance. Bound recursion with a
cutoff; below it, run serially. Measure stolen tasks and scheduler overhead.

Do not implement a new lock-free or work-stealing queue merely because the
algorithm needs tasks. Prefer a mature runtime unless queue semantics themselves
are the measured bottleneck and memory-order reasoning is tested rigorously.

## Bound recursive parallelism with a serial cutoff

Irregular recursion benefits from work stealing only while subproblems are large
enough to repay task creation. `parallel101/course/06/08_qsort/07/main.cpp`
spawns both recursive partitions at every level; `08/main.cpp` switches small
partitions to serial `std::sort`. The cutoff bounds task count, preserves leaf
locality, and leaves the scheduler coarse branches worth stealing.

Derive the cutoff by sweeping subproblem size on representative distributions;
it depends on comparator cost, element movement, runtime overhead, core count,
and cache. Keep pivot pathology and recursion depth in the correctness/risk
model. The examples have timers but no pinned results, so they establish the
experiment—not a universal `2^16` threshold.

## Use TLS reduction and scratch

Replace per-element shared updates with per-thread or per-task local state:

1. Allocate/initialize local accumulators, histograms, queues, or scratch.
2. Process an owned chunk without atomics on the hot path.
3. Merge local results in a separate reduction phase.

Choose local layout so each worker writes private cachelines. For large
histograms, per-thread replication may exceed cache; use blocked/key-partitioned
reductions or hierarchical merges.

TLS scratch avoids repeated allocation but has costs:

- capacity can remain resident for the thread lifetime;
- memory multiplies by runtime worker count;
- reentrancy and nested calls can alias the same scratch;
- teardown and dynamic-library lifetime can surprise;
- task migration means TLS is thread-local, not task-local.

Prefer explicit task/arena scratch when task identity matters. Clear logical
contents without necessarily discarding reusable capacity, and benchmark both.

`parallel101/course/07/05_malloc/15` and `16` show local scratch allocation
versus `static thread_local` capacity reuse. The example can retain roughly
128 MiB per worker, so a thread pool may turn one removed allocation into
gigabytes of resident memory. Define a capacity bound, trimming policy,
reentrancy/nesting behavior, and exception-safe logical reset; prefer caller-
owned scratch when lifetime can be explicit.

Floating reductions change association. Apply the numerical policy from
`numerics-and-quantization.md`.

## Overallocate locally, compact, then publish once

When a parallel filter does not know each chunk's output count, reserve
worst-case private output, compact into it without synchronization, then publish
one exact span. `parallel101/simdtutor/foundation/cpp17pmrtest/filter.cpp`
combines thread-local unsynchronized PMR storage, SIMD filtering, and one global
`grow_by` per chunk. The pattern removes per-match allocation and shared append
traffic and composes with the LUT compaction trick in `simd-and-compiler.md`.

Budget worst-case scratch times active tasks, define whether cross-task output
order matters, and respect object lifetime when skipping initialization. Pool
capacity/lifetime and the final concurrent append still have costs. The corpus
does not pin timings for this example; benchmark it as a composition pattern.

## Choose append or scan-based stream compaction

A parallel filter that produces a dense vector is **stream compaction**. Compare
two families rather than assuming one universal implementation:

- **Local append plus publication:** filter each task into private storage, then
  reserve one output span and bulk-copy it. This minimizes input passes and often
  suits CPUs, but needs task scratch and may publish chunks out of input order.
- **Flag/count, exclusive scan, scatter:** turn each predicate into `0/1`, scan
  to obtain exact output positions, allocate once, then scatter passing elements.
  This is stable, contiguous, allocator-free inside the hot kernels, and maps
  naturally to GPUs, at the cost of extra passes and temporary traffic.

`parallel101/course/06/07_filter/01` through `10` form a direct comparison. `02`
appends every hit to `concurrent_vector`; `03` batches through a local vector and
one `grow_by`; `04` adds worst-case local reserve and bulk `std::copy`. This `04`
variant is the fast `grow_by` implementation in the current checkout. `05`–`07`
compare mutex/spin-mutex publication, `08` takes one atomic output ticket per
task, and `09` expresses local vectors and concatenation through
`parallel_reduce`. The checkout contains task-local vectors but no explicit
`enumerable_thread_specific` implementation.

`10` is the accelerator-friendly stable form. It computes `sin` once into an
intermediate array, evaluates the predicate during both scan and scatter, stores
`N+1` prefix positions, and allocates exactly `ind.back()` outputs. A lower-memory
two-pass variant counts only per chunk, scans the chunk counts, then re-evaluates
the predicate while computing a local rank inside each chunk. Recomputing a cheap
predicate can cost less than reading and writing an element-sized position array.

Choose from selectivity, predicate cost, ordering, output construction cost,
scratch budget, and target architecture. Validate empty/all-pass/all-fail cases,
chunk tails, stable order when promised, and nontrivial object lifetime. The
course's `pod<T>` bypasses value initialization and is not a general raw-storage
abstraction; none of the examples consumes or correctness-checks the result, and
no timing table is bundled. Repair the harness before ranking them.

The canonical GPU description is [scan-based stream compaction](https://developer.nvidia.com/gpugems/gpugems3/part-vi-gpu-computing/chapter-39-parallel-prefix-sum-scan-cuda):
scan assigns dense destinations and scatter writes the selected elements.

## Build flat grid buckets with count scan scatter

The multi-bin generalization is **parallel binning**, also called
**histogram/count–scan–scatter** or counting-sort-style binning for a bounded
dense key space:

1. map every particle/item to a cell key and count each cell;
2. exclusive-scan counts into `cellOffsets` and allocate one flat index array;
3. scatter item indices into each cell's interval using per-cell cursors.

The result is a flattened ragged array: `cellOffsets[c]..cellOffsets[c+1]` names
one cell's particle indices. It is the same values-plus-offsets shape as CSR or a
compressed adjacency list, without one allocation per cell. Neighbor traversal,
MPM G2P/P2G preparation, and repeated cell queries gain contiguous ranges and a
small metadata array.

Global atomics are reasonable when keys are dispersed and contention is low;
they degrade when many particles hit a few cells. Compare:

- warp/block aggregation so one atomic reserves a run per distinct local key;
- block-private histograms followed by a hierarchical merge and scan;
- spatial partitioning that gives a block ownership of cells or tiles;
- radix sort by cell or Morton key, then run-length encode cell starts/ends.

Sorting is not automatically cheaper than two atomic passes. It adds radix passes
and temporary storage, but can repay them when high contention or repeated
neighbor work benefits from particle locality. NVIDIA's
[uniform-grid particle example](https://developer.download.nvidia.com/compute/cuda/1.1-Beta/x86_64_website/projects/particles/doc/particles.pdf)
compares atomic grid construction with radix sorting and cell-range discovery;
the sort-based path groups nearby particles in memory.

Do not claim that sorting alone makes MPM P2G atomic-free. Particles still update
overlapping grid nodes. Sorted/bin-local particles enable shared-memory
aggregation, segmented reduction, grid-node-owned gather, or a conflict-free
coloring; one of those must remove the actual write conflict. Measure key
distribution, atomics per particle, contention/replay, sort and scan traffic,
cell occupancy, and reuse across subsequent G2P/P2G stages.

## Prevent false sharing

False sharing occurs when independent writers repeatedly transfer ownership of
the same coherence line. Typical victims are adjacent counters, queue indices,
flags, allocator metadata, and per-thread results.

- Group data by writer, not merely by semantic structure.
- Separate concurrently written fields by a measured/configured destructive
  interference size.
- Keep frequently read shared values away from frequently written state.
- Publish in batches when visibility latency permits.
- Verify with scaling/counters; padding every structure can waste cache.

True sharing—several workers updating the same logical value—needs a different
algorithm such as partitioning, local accumulation, or hierarchical reduction.

`parallel101/course/07/09_multicore/01` is a direct caution: distinct OpenMP
indices still ping-pong when their integers occupy one coherence line. Its
“fixed” version spaces slots by 4096 integers—16 KiB—which is intentionally
excessive and shifts pressure into cache/TLB footprint. Isolate one writer-owned
slot per measured destructive-interference unit, align the base, move allocation
outside timing, and merge after the parallel region.

## Choose queue semantics

Define producers, consumers, capacity, ordering, blocking, cancellation, and
publication latency before choosing a queue.

- SPSC rings can use much simpler synchronization than MPSC/MPMC queues.
- Bounded queues provide backpressure and predictable memory.
- Unbounded queues can convert overload into memory growth and tail latency.
- Spin waits favor very short waits on dedicated cores but burn CPU and power.
- Blocking/atomic wait reduces idle cost but adds wake latency.
- Batch enqueue/dequeue amortizes atomics and fences but delays individual items.

Keep producer and consumer positions on separate coherence lines when they are
written independently, and cache the remote position when the protocol permits.
Memory ordering is part of correctness; benchmark results cannot validate it.

## Amortize coherence with cached cursors and batches

The bundled `parallel101/simdtutor/foundation/cpplockfreequeue/` progression
isolates a powerful SPSC pattern: separate writer-owned cursors, keep local
non-atomic positions, consult a cached remote cursor until apparently full or
empty, perform an acquire refresh only on that slow path, and release-publish a
range rather than every item. This reduces shared cacheline traffic toward the
number of batches or wrap-pressure events instead of the number of elements.

The protocol is strictly bounded SPSC, not MPSC, MPMC, or a work-stealing deque.
Publication batching raises throughput by delaying visibility, so latency is
part of the API contract. Prove acquire/release publication and object lifetime;
choose spinning versus atomic wait from wait duration, CPU budget, and wake
latency. The staged code has no pinned timing table and must be measured locally.

## Design bounded pipelines

Pipeline parallelism overlaps stages over different items. Describe stages,
dependencies, state ownership, and maximum in-flight tokens.

- The slowest stage bounds steady throughput.
- Token count must cover latency without creating excessive queueing or memory.
- Serial stages need an explicit ordering reason.
- Stateful stages should own or receive isolated state rather than hide globals.
- Fuse stages when intermediate traffic dominates; split stages when fusion
  harms parallelism, vectorization, cache, or accelerator occupancy.
- Apply backpressure from sinks to sources and define cancellation/error drain.

Measure both service time and queue wait. A pipeline can raise throughput while
worsening single-item and tail latency.

## Use tokens as a throughput and memory control

`parallel101/course/06/09_pipeline/01`, `03`, and `05` progress from whole-item
serial execution through stage barriers to a bounded `parallel_pipeline(8)`.
Different items occupy different stages concurrently, while the token limit
bounds live item state and supplies backpressure.

Choose the smallest token count that keeps the bottleneck stage supplied. More
tokens cannot raise throughput beyond the slowest service rate; they increase
queueing, memory, and result latency. Sweep token count and record stage service
and wait separately. The final example changes one stage's implementation, so
it is not a clean semantic A/B benchmark; use it to teach the mechanism, not to
attribute any timing difference solely to pipelining.

## Treat a future as a dependency handle

The `parallel101/course/05/02_async/` progression separates result ownership,
waiting, polling, deferred work, shared results, and explicit promise/thread
wiring. A future says how a result becomes available; it does not prove a new
worker exists or that execution overlaps. Default `std::async` may select async
or deferred execution, while `shared_future` duplicates observation rather than
work.

Choose the launch policy or executor deliberately and propagate cancellation and
exceptions. The polling example treats every non-ready status alike and loops
forever when `wait_for` returns `deferred`; the manual thread/promise example
needs RAII joining and `set_exception` on producer failure. Avoid polling when a
dependency edge or continuation suffices, bound outstanding work, and measure
launch cost before using one future per small task.

## Launch asynchronously with a dependency model

Asynchronous does not mean parallel and does not make work free. `std::async`
with default policy may defer execution; specify the policy or use an explicit
executor/runtime when concurrency is required.

Represent dependencies with futures/events/task edges and avoid immediate waits
that serialize the launch. Batch work until useful compute amortizes launch and
handoff overhead. Use double or ring buffering only with clear ownership so one
stage never overwrites a buffer still in use.

For CPU/accelerator pipelines, read `accelerator-throughput.md`. Define when data
becomes visible, what synchronizes it, and how failures/cancellation propagate.
