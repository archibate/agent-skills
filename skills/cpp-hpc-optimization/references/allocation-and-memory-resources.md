# Allocation and Memory Resources

## Contents

- [Verify allocation is the bottleneck](#verify-allocation-is-the-bottleneck)
- [Remove allocation work before replacing the allocator](#remove-allocation-work-before-replacing-the-allocator)
- [Match the strategy to lifetime and concurrency](#match-the-strategy-to-lifetime-and-concurrency)
- [Reuse container capacity deliberately](#reuse-container-capacity-deliberately)
- [Use caller-provided and preallocated buffers](#use-caller-provided-and-preallocated-buffers)
- [Use PMR as a resource-injection seam](#use-pmr-as-a-resource-injection-seam)
- [Use monotonic arenas for phase lifetimes](#use-monotonic-arenas-for-phase-lifetimes)
- [Use pools for repeated size classes and independent frees](#use-pools-for-repeated-size-classes-and-independent-frees)
- [Choose task-local or thread-local scratch](#choose-task-local-or-thread-local-scratch)
- [Use object and slab pools only for a proven object pattern](#use-object-and-slab-pools-only-for-a-proven-object-pattern)
- [Simulate local allocation with offsets and checkpoints](#simulate-local-allocation-with-offsets-and-checkpoints)
- [Keep stack allocation statically bounded](#keep-stack-allocation-statically-bounded)
- [Compare general-purpose allocator families](#compare-general-purpose-allocator-families)
- [Account for NUMA and cross-thread frees](#account-for-numa-and-cross-thread-frees)
- [Design a representative allocator benchmark](#design-a-representative-allocator-benchmark)
- [Validate lifetime and memory behavior](#validate-lifetime-and-memory-behavior)
- [Use the bundled allocation experiments carefully](#use-the-bundled-allocation-experiments-carefully)

Use this reference only after profiling shows that repeated allocation,
deallocation, allocator synchronization, fragmentation, page management, or
retained memory materially limits the declared objective. An allocator change is
not a substitute for fixing an allocation-heavy algorithm or data structure.

## Verify allocation is the bottleneck

Attribute the observed cost before choosing a remedy:

- count allocation/deallocation calls by size, alignment, call site, thread, and
  phase;
- sample CPU time and contention inside allocator paths;
- distinguish allocator bookkeeping from constructors, initialization, zeroing,
  page faults, cache misses, and later pointer-chasing;
- record live bytes, requested bytes, resident set, committed/retained bytes,
  peak memory, and allocation-rate high-water marks;
- identify remote frees, cross-thread ownership transfer, NUMA placement, and
  whether latency spikes coincide with refill, purge, mapping, or reclamation;
- compare cold start, warmed steady state, bursts, and idle periods.

Use an allocation profiler or allocator telemetry beside CPU profiles and
end-to-end measurements. A hot `malloc` frame can be a symptom of millions of
avoidable objects; a low CPU percentage can still hide unacceptable RSS,
fragmentation, page-fault, or p99 latency behavior.

## Remove allocation work before replacing the allocator

Prefer transformations that make the allocator irrelevant:

1. Remove temporary materialization, per-element ownership, and needless copies.
2. Pre-count, prefix-scan, or otherwise determine the final size and allocate once.
3. Reserve or resize once when a safe upper bound is cheap.
4. Flatten pointer trees and node containers into contiguous values, offsets, or
   indices.
5. Batch many small records into one block or homogeneous pool.
6. Reuse caller-owned scratch across calls when its lifetime is naturally explicit.
7. Fuse phases only when doing so removes storage without inflating the live set.

Re-run the profile after each structural change. Replacing the process allocator
may reduce synchronization or fragmentation, but it cannot recover locality lost
to individually allocated nodes and pointers.

## Match the strategy to lifetime and concurrency

Choose the narrowest resource whose lifetime matches the data:

| Workload contract | First candidate | Primary risk |
|---|---|---|
| Fixed, small compile-time bound | automatic `std::array` | stack budget multiplied by call depth and threads |
| Caller knows a maximum | caller-provided span/buffer | overflow policy and alignment |
| Many values die at one phase boundary | monotonic/bump arena | peak retention and skipped individual reclamation |
| Repeated size classes with arbitrary frees | segregated/PMR pool | fragmentation, pool growth, synchronization |
| Per-task temporary state | task-owned scratch/arena | task lifetime and aggregate in-flight memory |
| Per-worker reusable state | bounded TLS scratch | worker-count multiplication, nesting, idle retention |
| Homogeneous stable objects | object/slab pool | object lifetime, stale handles, sparse occupancy |
| Dynamic mixed process heap | measured general allocator | global integration, retention, workload crossover |

Define ownership, reset point, maximum capacity, overflow/OOM behavior, alignment,
thread access, and whether individual destruction is required before selecting an
API. Make the resource outlive every container and object that refers to it.

## Reuse container capacity deliberately

`clear()` destroys elements but normally retains capacity. This can remove repeat
allocation when the same owner performs similarly sized work, but retained memory
becomes part of that owner's footprint.

- reserve from a measured bound or previous high-water mark, not an arbitrary
  enormous constant;
- define whether capacity shrinks after an exceptional spike, after an idle
  interval, or never;
- use hysteresis so trimming does not create allocate/free oscillation;
- account for element destruction and initialization even when storage is reused;
- keep scratch ownership explicit when reentrancy or nested calls are possible.

Do not call `shrink_to_fit()` in a hot loop. It is a non-binding request and can
turn capacity reuse back into repeated allocation and copying.

## Use caller-provided and preallocated buffers

Prefer caller-provided scratch when the caller knows the batch, frame, request, or
timestep lifetime. Pass a span/view into the hot operation and keep the owning
buffer in the cold orchestration layer. This makes the memory budget visible,
supports per-task ownership, and avoids hidden TLS or global state.

For a compile-time bounded local buffer, express the bound and overflow policy:

```cpp
alignas(std::max_align_t) std::array<std::byte, kScratchBytes> storage{};
auto scratch = std::pmr::monotonic_buffer_resource{
    storage.data(), storage.size(), std::pmr::null_memory_resource()};
auto temporary = std::pmr::vector<Record>{&scratch};
```

`null_memory_resource()` makes exhaustion observable as `std::bad_alloc`; an
ordinary upstream resource silently grows onto the heap. Choose intentionally.
Large or input-dependent buffers belong in caller-owned heap/arena storage, not
on every worker's stack.

## Use PMR as a resource-injection seam

`std::pmr` separates container behavior from runtime allocation policy. It does
not make allocation faster by itself. Use it when the same operation genuinely
needs selectable lifetime resources without templating the whole public API.

- construct PMR containers with the intended `memory_resource` at the ownership
  boundary;
- keep the resource alive longer than all containers and nested PMR values using
  it;
- verify copy, move, swap, and nested-container behavior instead of assuming the
  resource propagates like an ordinary value;
- pass the resource or a resource-owning value type explicitly; do not change the
  process-wide default resource as hidden dependency injection;
- dispatch resource policy outside the measured inner loop.

Use a custom `memory_resource` only when an existing resource cannot express the
contract. Preserve alignment, matching deallocation, equality semantics, OOM
behavior, and upstream ownership.

## Use monotonic arenas for phase lifetimes

Use `std::pmr::monotonic_buffer_resource` or a proven bump arena when many
allocations share one destruction/reset boundary. Allocation advances a cursor;
individual deallocation does not reclaim space, and the resource releases its
blocks together.

This fits parsers, request graphs, compiler passes, frame/timestep temporaries,
and build-then-discard structures. It is a poor fit when long-lived objects keep
an arena alive, individual reclamation matters, or one growing container repeatedly
abandons old buffers in the same arena.

Measure the high-water mark across realistic phases. Bound upstream growth or use
a failing upstream when memory must be deterministic. Destroy live objects before
`release()`; bulk storage release does not make using invalidated objects legal or
replace required destructor side effects.

## Use pools for repeated size classes and independent frees

Use `std::pmr::unsynchronized_pool_resource` for one-thread/one-task ownership and
`synchronized_pool_resource` only when the same resource must be accessed
concurrently. Partitioning ownership often beats paying synchronization on every
operation.

Pools serve size classes from reusable chunks and return oversized requests to an
upstream resource. Sweep `pool_options` only with evidence; bad chunk limits can
increase fragmentation or refill frequency. Define when `release()` occurs and
how much empty capacity may remain resident.

Pool storage is not object storage semantics. Containers still construct and
destroy elements, and raw pool users must perform lifetime operations correctly.
Never recycle bytes while a pointer, reference, iterator, or asynchronous user can
still reach the previous object.

## Choose task-local or thread-local scratch

Prefer task/request-owned scratch when work can migrate between workers or nest.
It follows semantic ownership and makes the in-flight memory bound approximately:

```text
peak scratch <= maximum concurrent tasks * per-task high-water mark
```

Use `thread_local` capacity reuse only when thread identity is the correct lifetime
and calls cannot alias the same scratch unexpectedly. Define:

- the runtime's maximum worker count and thread teardown behavior;
- reentrancy, recursion, coroutine suspension, and nested parallel-call policy;
- a capacity cap, trimming/idle policy, and response to a one-time huge request;
- whether cross-thread handoff or freeing is forbidden.

TLS trades allocation latency for retained memory. A large buffer retained by
every thread in several pools can cost more than the allocator calls it removed.

## Use object and slab pools only for a proven object pattern

Use an object/slab pool when allocation remains hot for many homogeneous objects
with compatible size, alignment, ownership, and lifetime behavior. Prefer dense
value storage or indices first when pointer stability is not required.

Specify:

- slab growth and empty-slab reclamation;
- free-slot representation and cacheline layout;
- constructor, destructor, exception, and over-alignment handling;
- double-free and stale-handle detection in debug builds;
- cross-thread free ownership and synchronization;
- whether stable pointers are worth fragmentation and sparse traversal.

For externally visible identity, prefer an index plus generation counter over a
bare recycled pointer. Never design a lock-free freelist casually: ABA, memory
reclamation, and object lifetime are separate correctness problems.

## Simulate local allocation with offsets and checkpoints

A bounded arena can model local allocation without exposing individually owned
heap objects. Allocate aligned ranges by advancing an offset, store offsets or
indices rather than pointers when relocation is useful, and capture a checkpoint
before a nested phase. Rewind to the checkpoint only after every later allocation
is dead.

This gives constant-time allocation/reset, compact metadata, relocatable blocks,
and clear phase ownership. It does not provide arbitrary free. Check addition and
alignment for overflow, preserve the arena's maximum alignment contract, and run
destructors or restrict the arena to trivially destructible values before rewind.

Use separate arenas for independently reset lifetimes. A single global bump arena
couples unrelated phases and turns one long-lived object into unbounded retention.

## Keep stack allocation statically bounded

Prefer ordinary automatic objects and `std::array` for small compile-time bounds.
Treat `alloca`/variable-length stack allocation as a non-portable, last-resort
optimization:

- stack overflow has no recoverable allocation failure and can be undefined;
- space lasts until the function returns, not merely until the enclosing scope
  ends, so repeated calls inside one frame can accumulate;
- recursion, large worker counts, guard-page probing, and platform stack limits
  change the safe bound;
- it is not standard C++ and is compiler/platform dependent.

Do not choose `alloca` merely because a microbenchmark makes pointer bumping look
cheap. Use a bounded automatic array, caller buffer, small-buffer optimization, or
bounded monotonic resource unless the deployment ABI and maximum size are proven.

## Compare general-purpose allocator families

Benchmark the deployed system allocator first. Consider whole-process or
allocator-aware alternatives only after structural and lifetime-scoped strategies
leave a measured dynamic mixed-allocation bottleneck.

| Family | Mechanisms worth evaluating | Watch closely |
|---|---|---|
| jemalloc | arenas, thread caches, decay/purge controls, extensive stats/profiling | retained/dirty pages, arena count, tcache memory, tuning complexity |
| Google TCMalloc | per-CPU caches on supported Linux, legacy per-thread mode, size classes, heap profiles | cache footprint, CPU/thread behavior, release policy, platform support |
| mimalloc | sharded free lists, explicit heaps, remote-free path, eager page purging, secure mode | selected major version, override integration, workload-specific claims |
| oneTBB `tbbmalloc`/scalable allocator | scalable allocation API, allocator adaptors, pools over supplied regions | oneTBB integration/version, preview pool APIs, replacement boundary |

Do not paste vendor benchmark rankings into a production decision. Reproduce the
application's size/lifetime/thread mix on target hardware. General allocators can
have different winners for throughput, tail latency, fragmentation, idle RSS,
startup, or security hardening.

Keep allocation and deallocation within a compatible allocator domain. Be careful
across shared libraries, plugins, foreign runtimes, static/dynamic CRT boundaries,
and APIs that require their own release function. Test the actual link/interpose
mechanism; do not assume an environment preload replaces every allocation path.

## Account for NUMA and cross-thread frees

Allocation placement and deallocation ownership can dominate on multisocket
systems. Measure first-touch placement, remote memory traffic, thread migration,
arena/heap affinity, and producer-consumer handoff. First-touch is platform policy,
not a portable C++ guarantee.

Prefer partitioned ownership and per-node/task resources when data remains local.
When one thread allocates and another frees, include the allocator's remote-free
path and delayed reclamation in both latency and memory measurements. A per-thread
pool is unsafe if another thread can access it after the owner exits.

## Design a representative allocator benchmark

Keep an end-to-end benchmark beside any allocator microbenchmark. Record:

- allocation size and alignment distributions, including zero, tiny, large, and
  over-aligned requests that production permits;
- lifetime distribution, live-set high-water mark, burst/idle phases, and reuse;
- thread count, CPU affinity, NUMA placement, producer/freeing thread, and task
  migration;
- construction, initialization, payload touches, and traversal separately from
  raw allocation when diagnosis requires it;
- operations/second and p50/p95/p99 latency, not only mean nanoseconds per call;
- requested, active/live, resident, retained/committed, metadata, and peak bytes;
- page faults, mapping/purge calls, allocator locks/refills, and remote traffic;
- cold start, warmed allocator state, post-burst idle RSS, and shutdown cost.

Replay recorded production traces or generate a distribution with the same
correlations; uniform random sizes with immediate frees rarely represent a real
service. Compare one axis at a time under the same compiler, binary, runtime,
allocator configuration, and machine state. Include the unchanged baseline and
reject wins that merely move cost outside the timed interval.

## Validate lifetime and memory behavior

Before integrating an allocator optimization:

- test empty, exhaustion, maximum-size, over-aligned, exceptional-construction,
  reset, nested, reentrant, and cross-thread cases allowed by the contract;
- run address, undefined-behavior, thread, and leak checks where applicable;
- poison or generation-check recycled storage in debug builds;
- verify every resource outlives its consumers and every reset occurs after the
  last use and required destructor;
- test the declared OOM/overflow behavior instead of relying on spare upstream
  capacity;
- measure memory after bursts and idle periods, not only at steady peak load;
- preserve a simple default-allocator path until the optimized resource proves an
  end-to-end win and maintainable ownership model.

Document the selected resource, capacity/trim thresholds, thread ownership,
fallback, measurements, and rejected alternatives beside the benchmark.

## Use the bundled allocation experiments carefully

`parallel101/course/07/05_malloc/15` and `16` contrast a fresh large vector with
`static thread_local` capacity reuse. They motivate the experiment but omit a
production capacity policy; the retained buffer is roughly 128 MiB per worker.

`parallel101/simdtutor/foundation/cpp17pmrtest/oldmain.cpp` sketches PMR pools,
monotonic resources, and a bump resource. Treat it as experimental correction
material: its ranking comment has no pinned measurements, and the sketch lacks
production bounds and lifetime handling.

`parallel101/simdtutor/foundation/cpp17pmrtest/filter.cpp` combines per-worker
`unsynchronized_pool_resource`, private worst-case output, SIMD filtering, and one
bulk publication. Use it to study task-local allocation removal together with the
stream-compaction alternatives in `parallelism-and-pipelines.md`; benchmark the
complete pattern rather than attributing the result to PMR alone.
