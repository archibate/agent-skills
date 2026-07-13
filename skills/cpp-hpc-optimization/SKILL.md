---
name: cpp-hpc-optimization
description: >-
  Evidence-driven C++ high-performance computing design, profiling, and
  optimization across algorithmic time/space complexity, data layout, cache and
  memory behavior, numerics, SIMD, multicore scheduling, and CPU/accelerator
  pipelines. Use before designing or changing computation-intensive kernels,
  high-throughput data structures, performance-critical loops,
  SIMD/OpenMP/TBB/CUDA code, mixed-precision or sparse representations, or when
  investigating throughput, latency, scaling, cache, bandwidth,
  compiler-vectorization, or profiling problems.
---

# C++ HPC Optimization

Optimize the measured data path, not the code that merely looks low-level.
Preserve a simple reference implementation and make every optimization earn its
complexity with correctness evidence and a representative benchmark.

## Non-negotiable rules

1. **Define the contract first.** Record inputs, sizes, distributions, target
   hardware, accuracy, determinism, memory, latency, and throughput objectives.
2. **Pass the complexity gate.** Compare the best practical algorithmic families
   for the actual size range before tuning constants inside one family.
3. **Profile before kernel redesign.** Identify the hot path with end-to-end evidence.
4. **Keep an oracle.** Retain a scalar or otherwise obviously-correct reference
   implementation and compare every optimized path against it.
5. **Model before tuning.** Estimate useful operations, bytes transferred,
   working set, dependency depth, synchronization, and launch overhead.
6. **Change one axis at a time.** Measure after each transformation and revert
   changes that do not win on the target workload.
7. **Never encode a benchmark accident as a law.** Cache sizes, SIMD width,
   thread count, tile size, padding, and crossover thresholds are target- and
   workload-dependent.
8. **Keep a portable fallback.** ISA-specific kernels require feature dispatch,
   tail handling, and equivalence tests.

## Workflow

### 1. Frame the performance contract

Write down:

- the semantic result and accepted numerical error;
- representative and adversarial input shapes and distributions;
- steady-state throughput, single-item latency, tail latency, or deadline;
- memory-footprint and allocation constraints;
- target CPUs, accelerators, compilers, build flags, and deployment topology;
- whether batching, reordering, nondeterministic reductions, or preprocessing
  are permitted.

Do not optimize an unspecified target. Throughput and latency often demand
opposite choices: batching and deep queues improve throughput but add waiting.

### 2. Pass the algorithmic time/space complexity gate

Before applying cache, SIMD, threading, or instruction-level techniques:

- identify lower bounds and the best mature practical algorithm families for
  the declared sizes, distributions, sparsity, dimensionality, accuracy,
  update/query ratio, and number of timesteps or solves;
- compare total time, peak/live space, preprocessing, communication, numerical
  behavior, worst/expected cases, and implementation maturity;
- benchmark crossover regions and retain a size/shape-dependent portfolio when
  different algorithms win in different regimes.

An asymptotically better method may lose at small `n`; an asymptotically worse
regular kernel may exploit the target exceptionally well. Conversely, no amount
of constant-factor kernel tuning rescues an avoidable complexity class at scale.
Choose the industrially useful family for the declared range first, then use the
rest of this skill to reduce its realized cost. Preserve the declared semantic or
numerical contract; optimization need not be bit-exact when the contract permits
an approximate, reordered, or mixed-precision algorithm.

### 3. Establish correctness and measurement baselines

- Build a readable reference path before intrinsics, lossy precision, relaxed
  math, or concurrency.
- Create correctness tests covering empty, tiny, tail, misaligned, extreme,
  NaN/Inf, sparse/dense, and aliasing cases that the contract permits.
- Benchmark the actual hot operation with realistic data. Warm up, prevent
  dead-code elimination, report distribution rather than one lucky sample, and
  retain end-to-end measurements beside microbenchmarks.
- Inspect generated code and compiler optimization remarks before assuming the
  compiler failed.

Read `references/profiling-and-cost-model.md` before profiling, benchmarking,
or declaring a bottleneck.

### 4. Classify the limiting resource

Calculate at least an approximate per-item model:

- useful operations and transcendental/divide cost;
- compulsory input, output, metadata, and intermediate bytes;
- working-set size at each reuse distance;
- independent operations versus loop-carried dependency chains;
- tasks, locks, atomics, barriers, launches, copies, and queue transitions;
- scaling versus threads, vector width, batch size, and problem size.

Classify the current regime as memory-bandwidth, cache-capacity/latency,
compute/issue, dependency-latency, synchronization, task-granularity, launch, or
transfer bound. A kernel can move between regimes after each optimization.

### 5. Apply transformations in economic order

Prefer the first measured transformation that attacks the current limit:

1. Remove unnecessary work, copies, allocation, conversion, and materialization.
2. Reduce footprint and improve data layout or traversal locality.
3. Fuse passes or tile/block computation to reuse data before eviction.
4. Expose compiler optimization by removing false alias/dependency barriers.
5. Vectorize, using intrinsics only when generated code proves they are needed.
6. Parallelize with enough work per task and no shared hot write locations.
7. Batch, pipeline, or overlap copies and computation when latency can be hidden.
8. Offload only when transfer, launch, and synchronization costs fit the model.

Load the relevant references before choosing:

- `references/data-layout-and-memory.md` — DOD, AoS/SoA/AoSoA, packing,
  sparse data, locality, tiling, fusion, and Morton order.
- `references/ragged-topology.md` — flattened variable-length arrays, offset
  encodings, sidecar topology, packed sparse sets, polygon-corner topology,
  aligned attributes, and scan-built output.
- `references/numerics-and-quantization.md` — precision, FP16/BF16, shared
  exponent, quantization, accumulation, and numerical validation.
- `references/simd-and-compiler.md` — auto-vectorization, dependencies,
  intrinsics, SIMD tricks, tails, and ISA dispatch.
- `references/parallelism-and-pipelines.md` — thread degree, TLS reduction,
  false sharing, work stealing, queues, async launch, and pipelines.
- `references/accelerator-throughput.md` — CPU/accelerator transfer, CUDA-style
  streams, occupancy, synchronization, and launch amortization.
- `references/hotpath-polymorphism.md` — hot/cold boundaries, abstraction cost,
  and data-oriented polymorphism.

### 6. Validate and integrate

- Compare every output with the reference under the declared error metric.
- Run sanitizers and boundary tests before trusting benchmark results.
- Measure the same workload, hardware state, compiler, and flags before/after.
- Check performance across small, crossover, and large sizes; optimized kernels
  often lose below a threshold.
- Preserve the readable fallback and dispatch outside the inner loop.
- Record assumptions, selected thresholds, measured results, and rejected
  alternatives near the benchmark or design documentation.
- Keep cold-path architecture maintainable. Do not spread kernel-specific data
  layout or ISA details across the rest of the system.

## Relationship to C++ OOP design

Apply `$cpp-oop-style` to ownership, orchestration, I/O, error handling, and
module boundaries. Inside a measured hot kernel, prefer flat data, value views,
batch operations, static dispatch, and explicit SIMD when evidence requires it.

The boundary should normally look like:

- abstract behavior and resource ownership on the cold/control side;
- data-only request/config/result types at the seam;
- one dense concrete pool per hot subtype, with homogeneous spans or tiles
  entering the hot/data side;
- dispatch once per batch, never once per element;
- a reference kernel and one or more selected optimized implementations.

Read `references/hotpath-polymorphism.md` before removing abstractions or adding
type tags. Virtual dispatch is rarely the largest cost by itself; the lost
inlining, scattered objects, unpredictable branches, and pointer-chasing around
it are often the actual problem.

## Source material and provenance

Read `references/parallel101-case-studies.md` when looking for concrete lesson
progressions or deeper examples from archibate's `parallel101/course` and
`parallel101/simdtutor` repositories. Search the bundled offline corpus under
`references/parallel101/` before depending on a maintainer's checkout or the
network. Use `references/parallel101/provenance.tsv` to recover the repository,
author, source URL, commit, original path, teaching classification, license, and
SHA-256 for every excerpt.

Treat the corpus as educational experiments, not production code. The case-study
index marks outdated, unsafe, incomplete, or broken examples so their ideas can
be learned without copying their defects. The skill and bundled corpus are
licensed under CC BY-NC-SA 4.0; retain attribution and compatible terms when
redistributing adaptations.
