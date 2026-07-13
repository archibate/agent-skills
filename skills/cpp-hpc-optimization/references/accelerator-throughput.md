# Accelerator Throughput

## Contents

- [Decide whether to offload](#decide-whether-to-offload)
- [Optimize boundary count before kernel time](#optimize-boundary-count-before-kernel-time)
- [Model launch, transfer, and synchronization](#model-launch-transfer-and-synchronization)
- [Map work to the device](#map-work-to-the-device)
- [Use CPU SIMD as a bridge to GPU SIMT](#use-cpu-simd-as-a-bridge-to-gpu-simt)
- [Use the memory hierarchy](#use-the-memory-hierarchy)
- [Overlap through streams and buffers](#overlap-through-streams-and-buffers)
- [Control divergence and occupancy](#control-divergence-and-occupancy)
- [Fuse and split kernels deliberately](#fuse-and-split-kernels-deliberately)
- [Validate an accelerator path](#validate-an-accelerator-path)

This reference is CPU-first and uses CUDA-style terminology as a concrete model.
Confirm current platform APIs and device properties before writing code.

## Decide whether to offload

Offload when the workload has enough parallel work and arithmetic/reuse to
amortize:

- host-to-device and device-to-host transfer;
- allocation, mapping, and format conversion;
- kernel launch and dependency setup;
- synchronization and result visibility;
- maintenance of a second implementation.

Keeping a multi-stage working set resident on the device is often more important
than accelerating one isolated operation. Tiny or latency-sensitive requests may
remain faster on the CPU even when a large batch strongly favors the device.

## Optimize boundary count before kernel time

Partial offload can leave the surrounding iteration dominated by transfers,
synchronization, and CPU stages. The bundled
`parallel101/simdtutor/customers/amgcg_vcycle_cuda/rec.txt` records three levels
of the same AMG-CG workload: NumPy reports 0.5006 s in V-cycle and 0.5990 s for
the solve; CUDA V-cycle with NumPy CG reports 0.0817/0.1727 s; moving the broader
iteration to CUDA reports 0.0364/0.0560 s. The larger win came from removing
repeated execution boundaries and accelerating the rest of the pipeline, not
only tuning the headline V-cycle kernel.

Treat this as an end-to-end case study, not a reusable speed ratio. The notes
still mention matrix uploads, and the residual changes from about 5.69e-13 to
1.51e-11 while retaining 41 iterations. Account for setup and every remaining
boundary, keep persistent state where justified, and validate convergence and
residual tolerances before accepting the faster pipeline.

## Model launch, transfer, and synchronization

Measure separately and together:

- cold context/module initialization;
- allocation and registration/pinning;
- pageable versus pinned transfer;
- launch latency and number of kernels;
- device execution;
- event/stream synchronization;
- end-to-end latency and steady batched throughput.

Avoid a host synchronization after every launch. Use dependency events and wait
only where the consumer requires visibility. Do not assume a copy is globally
synchronizing; semantics depend on API, memory kind, stream, and direction.

Batch or use persistent/graph execution only after launch overhead is measured.
They trade flexibility and latency for lower repeated setup cost.

## Map work to the device

Choose a mapping that provides many independent blocks/workgroups and contiguous
lane accesses. Treat device "threads" as lanes in a scheduled group, not as CPU
threads with independent latency behavior.

- Make adjacent lanes access adjacent or coalescible addresses.
- Keep blocks independent unless the algorithm explicitly uses global phases.
- Use grid-stride/persistent patterns only with a measured reason.
- Size blocks from occupancy, instruction mix, shared memory, and register use;
  do not hard-code one universal block size.
- Handle tails and empty workloads without illegal launches or overrun.

Irregular sparse work may need compaction, bucketing, segmented kernels, or a
CPU path for very small/branchy cases.

## Use CPU SIMD as a bridge to GPU SIMT

The [Benchmark Game Mandelbrot kernel](https://benchmarksgame-team.pages.debian.net/benchmarksgame/program/mandelbrot-gcc-4.html)
is a compact bridge from CPU SIMD intuition to GPU SIMT. Each GCC `v2df` packet
advances two pixels through the same recurrence; a vector comparison creates lane
predicates, `movemask` compresses them, and the loop continues while any lane is
still bounded. The slowest pixel therefore determines packet lifetime, exposing
the same utilization problem as divergent work in a warp.

Use this conceptual mapping:

| CPU model | GPU analogy |
| --- | --- |
| SIMD packet | warp |
| SIMD lane | thread/lane within a warp |
| comparison mask | per-thread predicate or active mask |
| `movemask` | ballot |
| `any(mask)` | warp-wide any |
| adjacent lane addresses | the address shape desired for coalescing |

Keep the boundary explicit. CPU SIMD follows one vector control path; SIMT
threads retain per-thread state and can diverge and reconverge. The example keeps
doing arithmetic for escaped lanes until the packet exits, whereas divergent GPU
paths mask inactive lanes. A CPU vector load is one vector memory operation; a
GPU coalescer combines the addresses issued by separate lanes, and CPU gather is
a closer analogy for scattered GPU accesses.

Do not equate a CPU thread with a GPU block. A more useful hierarchy is OpenMP
team to grid, row/tile task to block, SIMD packet to warp, and SIMD lane to warp
thread. Treat this as a design metaphor, then verify the actual execution and
memory rules in the current [CUDA programming model](https://docs.nvidia.com/cuda/cuda-programming-guide/01-introduction/programming-model.html)
and [coalescing guidance](https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/writing-cuda-kernels.html#coalesced-global-memory-access).

## Use the memory hierarchy

Global memory bandwidth is useful only with enough coalesced requests in flight.
Use shared/local memory when a tile is reused enough to pay for loading and
synchronization. Include halos and bank/layout conflicts in the tile model.

Registers are fastest but finite. Large live state, unrolling, or fusion can
spill to local/global memory and reduce resident warps. Constant/read-only and
texture-like caches help specific access patterns; they do not repair arbitrary
scattered data.

Reduce footprint and transfer with suitable precision, but perform error and
range analysis from `numerics-and-quantization.md`. Device support for storage,
conversion, and native arithmetic can differ.

## Overlap through streams and buffers

To overlap copy and compute:

1. Partition work into chunks large enough to amortize launch/copy overhead.
2. Allocate bounded double/ring buffers with explicit ownership states.
3. Enqueue input copy, kernel(s), and output copy with event dependencies.
4. Keep independent chunks in flight across streams/queues.
5. Synchronize only when reusing a buffer or consuming its result.

Overlap is limited by copy engines, memory links, shared bandwidth, dependencies,
and pinned-memory availability. More streams can increase queueing without more
physical concurrency. Plot a timeline to prove overlap rather than inferring it
from asynchronous API names.

## Control divergence and occupancy

Branch divergence serializes paths within a lane group when both paths contain
active lanes. Prefer homogeneous batches, compaction, predication, or separate
kernels when the gain exceeds extra passes and traffic.

Occupancy is a means to hide latency, not the objective. Low occupancy can still
win for compute-heavy kernels with reuse; maximum occupancy can lose if it forces
smaller tiles or more instructions. Examine:

- registers and shared memory per block;
- active blocks/warps;
- eligible versus stalled warps;
- memory coalescing and cache behavior;
- instruction/pipe utilization.

Tune using current device tools and properties, not old fixed warp/bank or
"divergence is exactly 2x" rules.

## Fuse and split kernels deliberately

Fusion can remove global intermediate traffic and launches. It can also increase
register pressure, shared memory, divergence, code size, and recomputation while
reducing independent scheduling.

Split when stages require different mappings, precisions, or active subsets, or
when an intermediate compaction improves the next stage. Fuse when producer and
consumer share a tile and the resource model remains healthy. Benchmark both
with end-to-end transfers and synchronization included.

## Validate an accelerator path

- Run the same semantic tests as the CPU reference, including tails and small
  sizes.
- Use device memory/race/synchronization checkers.
- Test unsupported devices and explicit CPU fallback.
- Compare numerical results under the declared tolerance and reduction policy.
- Record device, driver/runtime, clocks/power state, compiler, flags, and launch
  configuration.
- Measure cold latency, warm latency, and steady throughput separately.
- Inspect a timeline and kernel metrics before explaining a result.
