# Profiling and Cost Models

## Contents

- [Start from the user-visible objective](#start-from-the-user-visible-objective)
- [Check algorithmic time and space first](#check-algorithmic-time-and-space-first)
- [Build the measurement ladder](#build-the-measurement-ladder)
- [Design a trustworthy microbenchmark](#design-a-trustworthy-microbenchmark)
- [Isolate split-cacheline cost with a dependency chain](#isolate-split-cacheline-cost-with-a-dependency-chain)
- [Classify the bottleneck](#classify-the-bottleneck)
- [Find the saturation knee](#find-the-saturation-knee)
- [Prefer realized machine cost to arithmetic Big-O](#prefer-realized-machine-cost-to-arithmetic-big-o)
- [Model throughput and latency separately](#model-throughput-and-latency-separately)
- [Measure scaling](#measure-scaling)
- [Run an optimization experiment](#run-an-optimization-experiment)

## Start from the user-visible objective

Optimization begins with a service-level question, not an instruction name.
Choose the primary objective explicitly:

- items, cells, pixels, samples, or bytes per second;
- time for one request, frame, timestep, or batch;
- p50/p95/p99 latency under a stated arrival rate;
- energy, memory footprint, or cost per result;
- time-to-solution subject to an accuracy bound.

Record the workload distribution. A uniform random benchmark can miss the
branch behavior, sparsity, locality, and early exits of production data.

## Check algorithmic time and space first

Treat microarchitectural optimization as phase two. Before profiling instructions,
write the whole-workflow cost in the variables that actually grow: items `n`,
dimension `d`, nonzeros `nnz`, neighbors `k`, iterations, timesteps, queries,
updates, and accuracy tolerance. Include preprocessing and repeated use rather
than timing only the inner call.

Compare the best practical families available for that contract:

- asymptotic and finite-size time, including worst, expected, and distribution-
  dependent behavior;
- peak and live space, temporary/workspace growth, metadata, and transfer volume;
- build/preprocessing cost versus query or timestep cost;
- exactness, approximation error, convergence, determinism, and stability;
- parallel span, communication complexity, regularity, and mature library support.

The theoretically smallest exponent is not automatically the industrial best
complexity for the production `n`. Model each candidate as a curve with setup and
constants, then measure the crossover:

```text
time_A(n) = setup_A(n) + a * f(n)
time_B(n) = setup_B(n) + b * g(n)
space(n)  = peak live payload + metadata + workspace
```

Space is not a secondary metric. A nominal time reduction that adds lookup
tables, tree nodes, indices, recursion workspace, or materialized intermediates
can move the workload into a worse cache/bandwidth regime. Conversely, compacting
space can reduce both capacity failures and time by cutting transferred bytes.

Use representative boundary cases:

- **Dense matrix multiply:** classical blocked Theta(n^3) GEMM can beat a naive
  Theta(n^2.807) Strassen implementation below its crossover because GEMM is
  extraordinarily regular; evaluate a tuned or fused Strassen implementation,
  not the exponent in isolation.
- **N-body interactions:** direct Theta(n^2) all-pairs is exact, simple, dense,
  and often best for small `n`. Barnes–Hut commonly gives expected
  O(n log n) behavior on suitable distributions, while fast multipole methods
  can approach O(n) for fixed accuracy and supported kernels; tree construction,
  approximation error, irregular traversal, and worst cases set the real gate.
- **PDE solves:** changing discretization, solver, or preconditioner can remove
  unknowns or iterations before tuning a stencil or sparse matvec. A near-linear
  multigrid method under its applicable assumptions can dominate heroic SIMD on
  an unnecessarily high-complexity solve.

The result of this gate may be a portfolio: direct kernels for small cases,
hierarchical or approximate algorithms beyond a measured crossover, and a
fallback for adversarial inputs. Only after selecting that family should cache,
layout, SIMD, threading, and accelerator tuning dominate the investigation.

## Build the measurement ladder

Use multiple levels; none replaces the others:

1. **End-to-end timing** confirms that the optimization matters to the product.
2. **Sampling profiler** identifies where CPU time or stalls accumulate without
   instrumenting every call.
3. **Timeline/tracing** reveals queueing, task gaps, synchronization, launches,
   copies, and CPU/accelerator overlap.
4. **PMU counters** test hypotheses about cycles, instructions, misses,
   bandwidth, branches, and vector utilization.
5. **Microbenchmark** isolates one transformation and its crossover point.
6. **Compiler reports and assembly** show whether code vectorized, inlined,
   unrolled, spilled, or retained unwanted loads and branches.

Do not call a timer around one function a profiler. Do not use a microbenchmark
alone to claim an end-to-end win.

## Design a trustworthy microbenchmark

- Use an optimized release build with the deployment compiler and relevant ISA.
- Warm instruction, data, allocator, runtime, and device state when measuring
  steady state; separately measure cold start when it matters.
- Prevent constant folding and dead-code elimination without adding `volatile`
  loads to the kernel under test. Use the benchmark framework's barriers.
- Randomize or rotate inputs when repeated execution would create unrealistic
  cache residency or branch predictability.
- Separate setup, allocation, transfer, and result checking unless they are part
  of the measured contract.
- Pin or at least record CPU placement; record frequency policy, SMT, NUMA node,
  compiler version, flags, problem size, and thread count.
- Report median and dispersion, not only the minimum. Investigate multimodal
  results rather than averaging unrelated machine states.
- Validate outputs outside the timed region and make the benchmark fail on a
  mismatch.

Latency experiments deliberately create dependency chains so later operations
must wait. Throughput experiments deliberately create independent operations so
the machine can overlap them. Mixing the two answers neither question cleanly.

## Isolate split-cacheline cost with a dependency chain

Do not reduce alignment to “aligned fast, unaligned slow.” The bundled
`parallel101/course/slides/bench/test.cpp` constructs a self-dependent pointer
chase and sweeps an 8-byte load across byte offsets. Because each address depends
on the prior load, memory-level parallelism cannot hide its latency.

The recorded `BM_latency.csv` stays near 79.4 ns per 100 dependent loads while
the value remains within one 64-byte line, rises to roughly 99.25 ns at offsets
57–63 where the load straddles two lines, then returns to baseline at offset 64.
This identifies the tested mechanism as split-line access, not misalignment by
itself. `BM_struct.csv` applies the same isolation to structure members.

Treat the numbers and 64-byte boundary as platform evidence, not a language
rule. Other ISAs can impose different penalties or alignment legality. The
reusable trick is experimental design: sweep one offset, force the dependency
whose latency is under test, and correlate the discontinuity with an actual
hardware boundary.

## Classify the bottleneck

Estimate arithmetic intensity:

```text
intensity = useful operations / bytes transferred from the limiting level
```

Count bytes from the level that is actually limiting. A tile reused from L1 has
a different model from a stream fetched once from DRAM. Include indices, masks,
temporary arrays, write allocation, and output traffic.

Compare the model with measurements:

- **Memory-bandwidth bound:** throughput tracks bytes, saturates with few cores,
  and improves when footprint or passes are reduced.
- **Cache-capacity/latency bound:** performance changes at working-set or stride
  boundaries; bandwidth may remain below peak because accesses lack concurrency.
- **Compute/issue bound:** data is resident, vector units or execution ports are
  busy, and reducing operations improves time.
- **Dependency-latency bound:** one accumulator or recurrence serializes work;
  more independent chains improve instructions per cycle.
- **Branch/front-end bound:** unpredictable control flow or code size limits
  useful issue; grouping homogeneous work may help.
- **Synchronization bound:** locks, atomics, barriers, coherence, or queueing
  dominate useful work.
- **Granularity/launch bound:** scheduling or device-launch overhead is large
  compared with each task or kernel.
- **Transfer bound:** host/device or stage-to-stage movement dominates compute.

This is a hypothesis, not a label. Confirm it by changing the suspected resource
or using relevant counters. Reclassify after each major transformation.

## Find the saturation knee

Parallel speedup is a curve, not a property of a loop. The bundled
`parallel101/course/07/01_bandwidth/01` through `07` hold a 1 GiB stream roughly
constant while varying operation cost and sweeping 1/2/4/6/8/10 OpenMP threads.
Cheap read-modify-write work should expose the memory-channel saturation knee;
more expensive arithmetic can continue scaling until compute or another shared
resource becomes limiting.

Reproduce the curve with useful bytes/s, operations/s, bandwidth counters, and
efficiency rather than copying a thread count. Control first-touch/NUMA, input
domain, compiler math mode, frequency, and placement. The examples have no
bundled results; one expensive function evaluates `sqrtf(x-2)` on zero-initialized
data, repeated iterations mutate global inputs, and global OpenMP thread settings
can contaminate benchmark order. Repair the workload before interpreting its
scaling.

## Prefer realized machine cost to arithmetic Big-O

Asymptotic operation count does not rank finite implementations. Model constants,
bytes moved between every hierarchy level, temporary footprint, synchronization,
available SIMD/SIMT instructions, shape handling, numerical behavior, and how
much tuned library machinery the algorithm can reuse.

Dense matrix multiplication is the instructive case. Classical blocked
Theta(n^3) GEMM packs panels, reuses them across many FMAs, tiles for caches and
registers, and maps regularly onto SIMD, tensor units, and parallel tiles. Its
arithmetic intensity grows with effective tile reuse, so a good GEMM is commonly
compute-bound even though an untiled triple loop can be memory-limited. This
differs from sparse matrix-vector products and many PDE stencils, whose low reuse
often leaves them bandwidth-bound.

Strassen reduces multiplication count to Theta(n^log2(7)), about Theta(n^2.807),
but adds matrix sums, recursion, shape/padding policy, intermediate traffic, and
different numerical error. A straightforward Strassen implementation can
therefore lose to a hierarchy-aware classical GEMM throughout the relevant size
range. That is a crossover result, not a law: practical implementations use a
few Strassen levels, call tuned GEMM at the leaves, and fuse additions into
packing or kernels to reduce movement.

Goto and van de Geijn's
[high-performance GEMM anatomy](https://www.cs.utexas.edu/~flame/pubs/GotoTOMS_final.pdf)
shows how multilevel-memory traffic shapes classical GEMM. Modern
[Strassen-on-GPU work](https://arxiv.org/abs/1808.07984) likewise reports gains
only after integrating the algorithm with the memory and thread hierarchy and
measuring explicit crossover sizes. Compare time-to-solution and accuracy on the
production shapes; never select a kernel from the exponent alone.

## Model throughput and latency separately

Batching, multiple accumulators, deep software pipelines, and queued asynchronous
work increase the number of operations in flight. They usually improve steady
throughput while adding waiting, memory, or result visibility latency.

For a pipeline, model:

```text
steady throughput <= 1 / max(stage service time)
single-item latency ~= sum(stage service times + queue waits)
in-flight memory ~= tokens * per-token state
```

For queues, distinguish enqueue/dequeue throughput from the time until another
thread can observe an individual item. Batch publication changes that contract.

## Measure scaling

Sweep rather than assume:

- problem size and working set;
- SIMD/scalar path and alignment;
- threads, SMT, and NUMA placement;
- task grain and chunks per worker;
- tile dimensions;
- batch size, queue capacity, and in-flight tokens.

Compare speedup and efficiency, and use Amdahl's law as a sanity bound. Flattening
before all cores are busy suggests bandwidth, serial work, imbalance, or shared
resources. A slowdown at high thread counts is useful evidence, not a reason to
hide those measurements.

## Run an optimization experiment

Use this loop:

1. State one hypothesis and the metric it predicts.
2. Make the smallest transformation that tests it.
3. Run correctness, sanitizer, and numerical checks.
4. Measure the same workload and machine state.
5. Inspect counters or generated code when the result differs from prediction.
6. Keep, revise, or revert the change.
7. Record the result, including failed ideas and crossover points.

Never combine layout, precision, threading, and SIMD changes in the first test;
you will not know which assumption was right or which defect changed the result.
