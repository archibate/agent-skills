# Parallel101 Case Studies and Corrections

## Contents

- [How to use this index](#how-to-use-this-index)
- [Why Parallel101 began](#why-parallel101-began)
- [Course: compiler and layout](#course-compiler-and-layout)
- [Course: cache, fusion, and multidimensional locality](#course-cache-fusion-and-multidimensional-locality)
- [Course: parallel scheduling and pipelines](#course-parallel-scheduling-and-pipelines)
- [Course: sparse data and precision](#course-sparse-data-and-precision)
- [Simdtutor: SIMD kernels and dispatch](#simdtutor-simd-kernels-and-dispatch)
- [Simdtutor: layout and memory case studies](#simdtutor-layout-and-memory-case-studies)
- [Simdtutor: queues, TLS, sparse, and GPU](#simdtutor-queues-tls-sparse-and-gpu)
- [Known corrections and traps](#known-corrections-and-traps)
- [Provenance and further sources](#provenance-and-further-sources)

## How to use this index

The primary teaching source is the curated offline corpus next to this file:

- `parallel101/course/` — selected Parallel101 course lessons.
- `parallel101/simdtutor/` — selected SIMD tutorials and real optimization cases.
- `parallel101/provenance.tsv` — author, source repository and URL, pinned commit,
  original path, teaching classification, purpose, license, and SHA-256 for every
  copied file.

Search narrowly before loading examples, for example:

```bash
rg -n "false.?sharing|cacheline|alignas" references/parallel101
rg -n "shared.?exponent|fp16|quant" references/parallel101
rg -n "dispatch|avx2|sse|omp simd" references/parallel101/simdtutor
```

For examples outside the curated set, use a maintainer's full local checkout if
present (`~/Projects/course` and `~/Projects/simdtutor`), then the upstream
repositories:

- <https://github.com/parallel101/course>
- <https://github.com/parallel101/simdtutor>

Each item below is one of:

- **Reference:** a clear concept or experiment to study.
- **Trick:** a compact, non-obvious mechanism with an especially clear contrast.
- **Progression:** compare adjacent versions; the delta is the lesson.
- **Counterexample:** useful because a simple rule failed.
- **Experimental:** inspect critically; do not copy as production code.
- **Broken:** contains a known or suspected correctness defect.
- **Gap:** the repository does not adequately teach the topic.

Reproduce results on the current compiler and hardware. Old timings and cache
sizes explain one experiment, not a universal ranking.

## Why Parallel101 began

Parallel101 began when a request to make an FEM `omp parallel for` scale exposed
a deeper representation mistake: material kinds were carried as strings instead
of a compact domain type. The enduring lesson is to choose sufficient algorithms,
representations, and data paths before multiplying work across SIMD lanes, cores,
or devices.

## Course: compiler and layout

- **Progression:** `04/6_structs/01_vec2_simd_ok` through
  `07_vec3_aosoa` introduces AoS, SoA, alignment, padding, and AoSoA in small
  steps. Use it to contrast SIMD within one `[x,y,z,pad]` record against packet
  SIMD across records as `[xxxx]`, `[yyyy]`, `[zzzz]`: the latter wastes no lane,
  avoids horizontal/shuffle-heavy dot and cross products, and widens naturally.
- **Progression:** `04/6_structs/08_benchmark/` puts AoS, padded AoS, OpenMP,
  SoA, SIMD, unroll, and AoSoA behind one driver. Rebuild and validate before
  accepting its ranking.
- **Reference:** `04/3_pointers/01_pointer_aliasing` and
  `02_restrict_pointer` show how possible aliasing blocks optimization.
- **Reference:** `04/5_loops/04_no_pointer_aliasing_ivdep` through the later
  loop examples contrast dependencies, opaque calls, random/strided/contiguous
  access, and invariant work. Teach that `restrict`/`ivdep` are correctness
  contracts, not magic flags.
- **Trick:** `04/5_loops/11_loop_invariant_motion` explicitly writes
  `b[i] * (dt * dt)` so strict floating-point semantics permit hoisting the
  square; `12_loop_invariant_failed` leaves the multiply in the loop because
  reassociation would change rounding.
- **Counterintuitive progression:** `specifelse/0.cpp` through `6.cpp` and
  `benchtest/demo0.cpp` compare branches, predicates, clamp idioms, switch, map,
  and dense LUTs across sorted and random inputs. The recorded uppercase gap
  combines prediction with SIMD exposure; repair mutation, dispatch, clamp, and
  LUT-bound defects before reproducing it. Duplicate `7.cpp` is omitted.
- **Reference:** `slides/bench/main.cpp`, `slides/bench/test.cpp`, and the CSV
  results distinguish throughput from dependency-chain latency and expose the
  cost of crossing cacheline boundaries.
- **Reference:** the full checkout's unbundled `17/slides.pptx` emphasizes
  profile-before-optimize and the small measured hot subset.

## Course: cache, fusion, and multidimensional locality

- **Progression:** `07/01_bandwidth/01` through `07` sweeps computation and
  thread count. Use it to observe bandwidth saturation and changing scaling,
  not to assert that memory-bound work can never benefit from parallelism.
- **Progression:** `07/02_cache/01` sweeps working set, `02` sweeps stride, and
  `03`/`04` compare layouts while changing which fields are consumed. This is
  the strongest local proof that layout follows access pattern.
- **Counterintuitive progression:** `07/03_prefetch/01` through `07` culminates
  in a 512 MiB write stream far beyond the noted 12 MiB L3. Ordinary cached
  overwrite can pay an RFO read plus dirty writeback, while full-line streaming
  output avoids the useless incoming line. Sweep cache-sized through memory-sized
  buffers and add aligned full-line AVX-512 temporal stores as a separate,
  microarchitecture-dependent ownership-without-data candidate.
- **Progression:** `07/04_fusion/00` removes an intermediate pass; `01` through
  `05` evolve a stencil into halo tiling, temporal fusion, SIMD/unroll, and
  streaming stores. Validate boundaries and the loss after every stage.
- **Progression:** `07/06_ndarray/01`/`02` compare nested and flat storage plus
  loop order. `07/08_matrix/01` compares transpose, tiling, Morton tile order,
  and TBB blocking; `02`/`03` extend blocking to matmul/convolution.
- **Reference:** `07/09_multicore/01` demonstrates false sharing, but its padding
  is intentionally excessive and not a production recipe.
- **Reference:** `07/05_malloc/15`/`16` compare repeated scratch allocation with
  `thread_local` reuse; add lifetime and memory-multiplication analysis.

## Course: parallel scheduling and pipelines

- **Progression:** `06/02_reduce/03`/`04` compare ordinary and deterministic
  reductions. `08` expresses prefix scan through TBB: use it to contrast serial
  dependency with work-efficient parallel span, and to account for body replay,
  traffic, association, reproducibility, and cost.
- **Progression:** `06/05_split/01` through `05` explore grain size and TBB
  partitioners. Measure locality and imbalance rather than naming one default.
- **Progression:** `06/07_filter/01` through `10` compare serial append,
  `concurrent_vector`, task-local buffering plus `grow_by`, locked/atomic
  publication, `parallel_reduce`, and scan–scatter stream compaction. `04` is the
  reserved-local-buffer plus bulk-copy `grow_by` candidate; `10` is stable and
  accelerator-shaped but pays extra passes and prefix-position storage.
- **Progression:** `06/08_qsort/07` through `10` add recursive tasks, cutoff,
  and parallel invocation. This illustrates work stealing for irregular trees;
  it is not an implementation of a work-stealing deque.
- **Progression:** `06/09_pipeline/01`, `03`, and `05` compare serial objects,
  stage barriers, and a bounded in-flight TBB pipeline. Token count illustrates
  throughput, latency, memory, and backpressure together.
- **Reference:** `05/02_async/01` through `06` cover futures, deferred execution,
  promise, and shared future. Correctly teach that default `std::async` policy
  need not create concurrent execution.

## Course: sparse data and precision

- **Progression:** `10/00/00.cpp`, `03.cpp`, `07.cpp`, `08.cpp`, and `10.cpp`
  evolve an infeasible
  dense representation toward map, COO, per-row data, and CSR-like offsets.
  Because the example is the fixed `[-1, 2, -1]` tridiagonal Laplacian, continue
  past generic CSR to `3 x N` DIA storage for row-varying coefficients or a
  matrix-free three-term stencil when the coefficients are analytical.
- **Reference:** `07/10_rbgs/01/main.cpp` applies red-black Gauss-Seidel directly
  as a neighbor stencil. It demonstrates an implicit structured operator and
  phase-dependent in-place updates, not a general sparse-matrix container.
- **Experimental:** `10/01/06.cpp` demonstrates block hashing and bit packing;
  inspect its coordinate-bit inconsistency before using the idea.
- **Progression:** `10/04/06.cpp` combines hash, pointer, and dense levels in a
  sparse spatial structure. Treat it as design exploration, not a container API.
- **Progression:** `10/05/00.cpp` through `04.cpp` compare integer widths,
  manual bitset, and `vector<bool>` as footprint experiments.
- **Broken/educational:** `10/06/03.cpp` through `07.cpp` demonstrate fixed-point and a
  BF16-like storage idea. `10/06/07.cpp` truncates FP32 high bits through illegal
  aliasing; replace with a correct format, rounding, and `std::bit_cast` lesson.

## Simdtutor: SIMD kernels and dispatch

- **Trick progression:** `result/sum.cpp` separates four effects: scalar
  recurrence, four-lane accumulation, ineffective 2x unrolling into one vector
  accumulator, and effective 2x unrolling into two independent accumulators.
  The recorded 7741/1933/1937/983 ns sequence makes dependency latency visible;
  preserve the floating-point reassociation warning when teaching it.
- **Counterexample:** `result/saxpy.cpp` shows compiler-generated SIMD can match
  or beat manual intrinsics; `restrict` and aligned access do not guarantee a win.
- **Trick progression:** `result/countp.cpp` turns all-one comparison masks into
  arithmetic counters and delays horizontal reduction, while its scalar
  `uint32_t` variant shows the compiler can nearly match the intrinsic form.
- **Trick progression:** `result/findp.cpp` checks 16 lanes with one coarse hot-
  path mask, then reloads and precisely locates only rare hits. Its win depends
  on the production hit-position distribution.
- **Experimental/reference:** `source/filterp.cpp` implements stable AVX2 stream
  compaction with a 256-pattern permutation/store-mask LUT, movemask, popcount,
  and a two-vector unroll. It is a high-value SIMD trick for ISAs without native
  compress-store; benchmark its 16 KiB LUT pressure and test all mask patterns.
- **Trick/corrected progression:** `result/fillsin.cpp` moves from double `sin`
  through `sinf`, scalar approximation, SSE, and AVX2 polynomial sincos. Preserve
  its recorded speed lesson only after adding alignment, tail, range, and error
  contracts to `source/fillsin.cpp`.
- **Mixed-precision centerpiece:** `blas/dsdot.cpp` combines FP32 storage with
  exact FP32-to-FP64 widening, FP64 FMA/accumulation, independent dependency
  chains, contiguous and strided paths, and an FP64 result. Preserve this design
  and repair its final cross-half reduction when adapting the historical code.
- **Companion lessons:** `blas/sdot.cpp` supplies the foundational FP32 dot-
  product dataflow; `blas/snrm2.cpp` turns the same reduction shape into a norm
  with one final square root. Add scaled sum-of-squares for production numerical
  range and repair `snrm2.cpp`'s `X3 * X4` strided term to `X4 * X4`.
- **Tuning laboratory:** use the BLAS trio to sweep `1x`, `2x`, and `4x` unroll
  independently from accumulator count; construct one `i32gather` index vector
  from lane number times stride; and verify every remainder modulo the complete
  `vector_width * unroll` block with a scalar or masked tail.
- **Reference:** `practices/dispatch.md` and `foundation/kernel_rgba2rgb.h`
  demonstrate compile-time/runtime ISA dispatch and scalar baselines.
- **Broken/design reference:** `foundation/kernel_hashrng.h` demonstrates
  counter-based lane independence, but several wide byte generators change the
  scalar stream or repeat blocks and have no statistical validation.
- **Progression:** bundled `source/` and `result/` pairs demonstrate reference
  comparison and assembly inspection. The full checkout's `watcher.sh` and
  benchmark scaffolding are optional tooling and are not bundled.

## Simdtutor: layout and memory case studies

- **Broken/design reference:** `customers/issue4_getsubpixelvalue/old.cpp` to
  `main.cpp` suggests SoA query streams and SIMD across four gathers, but the old
  reference drops y weights, SIMD coefficients have sign errors, integer-only
  inputs hide them, and the SIMD benchmark is disabled.
- **Counterexample:** `customers/parallel_multiply_uint8/README.md` first tries
  CHW/SoA, then keeps HWC/AoS and uses register shuffles, achieving a better
  measured result with less application disruption. Do not teach "always SoA."
- **Trick progression:** `result/rgba2rgb.cpp` packs four RGBA vectors as one
  macroblock so shuffles/blends produce exactly three full RGB stores. Guard the
  source example's tiny-size unsigned subtraction before adapting it.
- **Progression:** `foundation/radixsort/radix_sort.cpp` v1-v7 evolves nested
  buckets into pre-counted flat buffers, double buffering, larger radix, per-
  thread histograms, and fused phases. Track how fewer passes trade against
  histogram working set and TLS memory.
- **Reference:** `foundation/cpp17pmrtest/oldmain.cpp` exposes node/pointer/padding
  overhead for tiny payloads. Use it to motivate footprint accounting, not a
  blanket ban on linked structures.

## Simdtutor: queues, TLS, sparse, and GPU

- **Progression/experimental:** `foundation/cpplockfreequeue/v1_...` through
  `v12_...` evolve synchronization, cacheline separation, cached remote indices,
  local positions, batching, spin, and atomic wait. They are SPSC experiments,
  not MPMC or work-stealing production queues.
- **Reference:** radix-sort per-thread histograms and
  `foundation/cpp17pmrtest/filter.cpp` illustrate local scratch plus merge.
  `foundation/ScopeProfiler.h` merely stores records in TLS; it is not a TLS
  reduction example.
- **Experimental:** `customers/amgcg_vcycle_cuda/vcycle.cu` shows CSR/cuSPARSE
  and multilevel dataflow, but contains incomplete solving/resource design.
- **Experimental:** `foundation/moderncuda/cudapp.cuh` sketches streams, events,
  async allocation, and copies. Use current CUDA documentation for semantics.

## Known corrections and traps

- Never copy hard-coded cache sizes, 64-byte lines, tile/block sizes, thread
  counts, warp/bank assumptions, or benchmark timings as portable constants.
- `restrict`, `ivdep`, `omp simd`, manual unroll, non-temporal stores, and fast
  math impose prerequisites or semantic changes; verify them.
- Use `std::bit_cast`/`memcpy` for representation work, not pointer punning.
- Old warp-synchronous `volatile` reduction patterns need modern synchronization
  and `_sync` operations.
- `source/rgba2rgb.cpp`-like end calculations can underflow for inputs shorter
  than a vector; test zero/tiny/tails first.
- `result/filterp.cpp` is stale benchmark output stored under a `.cpp` suffix,
  not the result kernel. The curated corpus intentionally includes only the
  actual implementation in `source/filterp.cpp`.
- `source/fillsin.cpp` assumes a multiple-of-eight size and aligned output, and
  its approximation is validated only on a narrow finite domain.
- The historical `blas/{sdot,dsdot,snrm2}.cpp` final reductions need an explicit
  AVX cross-half combine; use asymmetric patterned lanes to verify the repair.
- `specifelse/benchtest/demo0.cpp` mutates benchmark input across repetitions;
  `4.cpp`'s arithmetic clamp and `5.cpp`'s five-element LUT variant also require
  the corrections documented in the SIMD reference.
- `foundation/kernel_hashrng.h` contains mismatched and repeated-block SIMD
  streams; a hash mixer also needs an explicit statistical/use contract.
- `customers/issue4_getsubpixelvalue/` lacks a valid scalar oracle and uses
  integer coordinates that conceal subpixel polynomial defects.
- Course async polling ignores `future_status::deferred`; the BF16/fixed-point,
  ndarray blur, and non-temporal-store examples also require the corrections
  documented in their domain references.
- `customers/5_calc_similarity/new.cpp`, `foundation/ringbuf`, and CUDA
  experiments contain suspected defects or
  nonportable constructs. Read as archaeology unless independently repaired.
- Profiling, microbenchmarking, counters, compiler reports, and tracing answer
  different questions; the repositories sometimes use the terms loosely.

## Provenance and further sources

The skill and curated corpus are released by archibate under CC BY-NC-SA 4.0;
the complete terms are in `../LICENSE`. The course already declares those terms,
and the author has extended them to the selected `simdtutor` teaching excerpts.
Retain attribution and compatible terms when redistributing adaptations. Consult
`parallel101/provenance.tsv` for exact source revisions and per-file hashes.

Maintainers regenerate the corpus with
`scripts/sync_parallel101_corpus.py` from the skill root. The explicit allowlist
excludes binaries, build products, generated files, presentation media, vendored
dependencies, and low-signal scaffolding. It preserves original repository paths
so discussion can point back to the complete source tree without ambiguity.

Supplement gaps and modernize details with primary documentation for the active
toolchain. Start with:

- LLVM's <https://llvm.org/docs/Vectorizers.html> and GCC's
  <https://gcc.gnu.org/onlinedocs/gcc/Developer-Options.html> for current
  vectorization capabilities and missed-optimization reports;
- GCC's <https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html> for the exact
  optimization and fast-math behavior of the installed compiler generation;
- the oneTBB specification for
  <https://oneapi-spec.uxlfoundation.org/specifications/oneapi/v1.4-rev-1/elements/onetbb/source/algorithms/functions/parallel_pipeline_func>
  rather than copying legacy course includes and APIs;
- CUDA's current
  <https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/asynchronous-execution.html>
  and <https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html> for
  streams, events, transfer overlap, occupancy, and synchronization semantics;
- current Intel/AMD/Arm ISA and optimization manuals, OpenMP specifications,
  and IEEE-754 format definitions for the target platform.

Verify current APIs before emitting code; the local repositories are
pedagogical snapshots.
