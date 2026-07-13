# SIMD and Compiler Optimization

## Contents

- [Make optimization legal and visible](#make-optimization-legal-and-visible)
- [Inspect the compiler](#inspect-the-compiler)
- [Write the legal algebra you want optimized](#write-the-legal-algebra-you-want-optimized)
- [Choose branch predicate or LUT from the distribution](#choose-branch-predicate-or-lut-from-the-distribution)
- [Vectorize the expensive function, not only its loop](#vectorize-the-expensive-function-not-only-its-loop)
- [Remove loop dependencies](#remove-loop-dependencies)
- [Use SIMD data movement intentionally](#use-simd-data-movement-intentionally)
- [Use counters to create independent lanes](#use-counters-to-create-independent-lanes)
- [Use mask representation as data](#use-mask-representation-as-data)
- [Reshape metadata and register macroblocks](#reshape-metadata-and-register-macroblocks)
- [Compact selected lanes with a LUT](#compact-selected-lanes-with-a-lut)
- [Speculate on the common outcome and replay rare hits](#speculate-on-the-common-outcome-and-replay-rare-hits)
- [Break reduction dependency chains](#break-reduction-dependency-chains)
- [Sweep unroll and accumulator counts](#sweep-unroll-and-accumulator-counts)
- [Handle reductions and horizontal work](#handle-reductions-and-horizontal-work)
- [Learn the SDOT DSDOT SNRM2 family](#learn-the-sdot-dsdot-snrm2-family)
- [Vectorize strided streams with indexed gathers](#vectorize-strided-streams-with-indexed-gathers)
- [Handle tails tiny inputs and alignment](#handle-tails-tiny-inputs-and-alignment)
- [Choose intrinsics only with evidence](#choose-intrinsics-only-with-evidence)
- [Dispatch across ISAs](#dispatch-across-isas)

## Make optimization legal and visible

Compilers optimize best when a loop has:

- contiguous or predictable accesses;
- simple induction variables and bounds;
- no hidden calls or visible side effects;
- no possible aliasing between input and output streams;
- no loop-carried dependency except a recognized reduction;
- constants and invariants visible at the optimization boundary;
- a profitable amount of work.

Use `std::span` or similarly explicit views for safe interfaces, but remember
that two spans may still overlap. Express non-aliasing only when the API contract
proves it. `restrict`, `ivdep`, and `omp simd` assert facts; using them when the
facts are false can silently miscompile results.

Keep the hot implementation visible to the optimizer through the same
translation unit, templates, or link-time optimization when appropriate. Avoid
code-generation contortions until reports show an actual visibility problem.

## Inspect the compiler

Before writing intrinsics:

1. Enable vectorization and missed-optimization remarks.
2. Inspect optimized assembly or compiler IR for the hot loop.
3. Confirm vector width, loads/stores, branches, spills, calls, and remainder.
4. Compare GCC/Clang or relevant deployment compilers when feasible.
5. Benchmark the compiler-generated version as the baseline.

Warnings and reports are evidence, not verdicts. A vectorized loop can be slower
because of gathers, shuffles, setup, cleanup, code size, or frequency effects. A
scalar loop can be optimal for tiny inputs.

## Write the legal algebra you want optimized

Under strict floating-point semantics, the compiler cannot silently change
parenthesization. In the bundled course progression,
`04/5_loops/11_loop_invariant_motion/main.cpp` writes `b[i] * (dt * dt)`, so the
square is explicitly invariant and can be computed once before the loop.
`12_loop_invariant_failed/main.cpp` writes `b[i] * dt * dt`; reassociating it
would change rounding, so a strict compiler retains another multiply in the
loop.

This is a surgical alternative to enabling global fast-math: state the intended
evaluation tree directly. It still changes numerical results relative to the
other parenthesization, so select it from the numerical contract, then verify
the hoist in optimization remarks or assembly. Apply the same reasoning to
constant conversions, reciprocal precomputation, and loop-invariant address
terms; do not hoist values whose exceptions, rounding mode, or alias-visible
loads are semantically observable.

## Choose branch predicate or LUT from the distribution

An `if`, ternary, comparison-as-value, clamp, or switch may become a branch,
`cmov`, `setcc`, min/max, masked SIMD, or jump table. Inspect optimized code;
choose from input entropy, skew, ordering, key density, and the cost of both sides.

`parallel101/course/specifelse/benchtest/demo0.cpp` records about 0.55 ms for a
ternary over ten million sorted or random bytes, versus 4.60 ms sorted and 7.03 ms
random for `if`. This combines prediction and vectorization: sorting helps the
scalar branch, while predication exposes packed SIMD.

The progression moves from Boolean arithmetic (`1.cpp`–`3.cpp`) through clamp
idioms (`4.cpp`) to if/switch/map/dense-LUT dispatch (`5.cpp`–`6.cpp`). Prefer
branches for predictable cases or expensive work worth skipping, predication for
cheap balanced work and SIMD, and LUTs for validated dense domains.

Before reproducing, restore identical input outside timing, measure branch misses
and vectorization, and separate dispatch cost. Correct `addmul_clamp` above 255
and reject `x >= 5` for the five-element LUT; `7.cpp` is a duplicate. Retain all
three candidates until the production distribution chooses.

## Vectorize the expensive function, not only its loop

Autovectorizing a loop does not help when every lane still calls scalar libm.
The bundled `parallel101/simdtutor/result/fillsin.cpp` isolates the progression:
double `sin` called accidentally from float code records 89,939 ns, `sinf`
53,622 ns, a scalar polynomial approximation 29,726 ns, four-wide SSE 7,266 ns,
and eight-wide AVX2/FMA 3,615 ns. The SIMD form keeps the index counter in lanes,
performs range/quadrant reduction, evaluates sin/cos polynomials, and reconstructs
sign/quadrant with masks.

The result is an approximate finite-domain kernel, not a faster libm contract.
Define input range, maximum/ULP error, rounding mode, NaN/Inf behavior, and
whether cosine work can be removed. The source requires `n % 8 == 0`, uses a
32-byte-aligned store without guaranteeing output alignment, and has no tail.
Use an unaligned store or proven allocator, add a tail, and test large arguments:
float indices lose integer exactness above `2^24`, the int32 counter wraps, and
the simple range reduction eventually fails.

## Remove loop dependencies

Distinguish true dependencies from compiler uncertainty.

- A recurrence such as `sum += x[i]` has a real accumulator dependency.
- Possible input/output overlap is an aliasing uncertainty.
- Reading a neighbor written earlier in the same loop is a true carried
  dependency and may require a different algorithm or wavefront schedule.
- Calling an opaque function may hide memory effects and block optimization.

For associative-enough reductions, use multiple independent accumulators and
combine them after the loop. This exposes instruction-level parallelism and
reduces one long latency chain. Choose the number by latency, throughput,
register pressure, and vector width; excess unrolling spills registers.

For stencils/recurrences, prove a legal interchange, tile, scan, prefix, or
double-buffer transformation. Never silence a dependency warning without a
correctness proof.

## Use SIMD data movement intentionally

SIMD speed is often limited by arranging data, not arithmetic. Know the cost and
semantics of:

- contiguous aligned/unaligned loads and stores;
- widening and narrowing with signedness and saturation;
- masks, blends, compares, and movemask extraction;
- lane-local versus cross-lane shuffles;
- permute, unpack, zip/unzip, transpose, and table lookup;
- gathers/scatters and their cache behavior;
- streaming/non-temporal stores;
- conversion between storage and compute precision.

Do not globally convert AoS to SoA merely to avoid a shuffle. Register-local
repacking can preserve an external AoS representation and still feed vector
arithmetic. Conversely, repeated complex shuffles across every stage may justify
a persistent SoA/AoSoA layout. For three-component dot/cross-heavy workloads,
read `data-layout-and-memory.md` and prefer packet SIMD across records when it
turns `[x,y,z,pad]` horizontal/shuffle work into three full vertical vectors.

Separate common homogeneous work from rare cases. Process a vector block with a
mask or fast predicate, then fall back only for lanes that need exact scalar
handling. This can improve throughput but may increase latency for the rare path.

## Use counters to create independent lanes

A counter-based hash/RNG maps `(seed, index)` directly to an output. It removes
mutable generator state and recurrence dependencies, so lanes, chunks, and
threads can generate arbitrary ranges independently without skip-ahead.
`parallel101/simdtutor/foundation/kernel_hashrng.h` demonstrates the intended
SSE/AVX/AVX-512 mapping and packed-byte output shape.

Treat this file as correction material, not a validated generator. Some AVX2
hash steps differ from the scalar path; fast byte variants intentionally change
the stream contract, and two wide variants fail to advance their vector counter,
repeating blocks. No statistical results are bundled. Define cross-ISA
reproducibility, counter wrap/period, output interval, byte-stream mapping, and
statistical quality; test exact known sequences plus an appropriate statistical
suite. A fast integer mixer is neither a cryptographic RNG nor automatically a
sound Monte Carlo generator.

## Use mask representation as data

An x86 vector comparison produces zero for false and all-one bits for true.
`parallel101/simdtutor/result/countp.cpp` exploits that representation: cast the
comparison masks to integer lanes and subtract them from a vector counter, so
each true lane adds one. Reduce lanes only after the loop. This avoids extracting
a movemask and executing popcount for every vector.

The recorded progression improves from 1042 ns for per-vector movemask/popcount
to 808 ns for mask arithmetic. A plain `uint32_t` source loop reaches 826 ns,
which is equally important evidence that the compiler may already discover a
competitive form. Preserve the representation invariant, bound lane-counter
overflow or fold periodically, and use a clean scalar tail. Comparison-mask
encoding and intrinsic spelling are ISA-specific even when the broader idea is
portable.

## Reshape metadata and register macroblocks

Do not globally transpose a large payload when a small control stream can be
reshaped in registers. In
`parallel101/simdtutor/customers/parallel_multiply_uint8/fast_mask_lib.hpp`, a
byte shuffle expands one 0/1 pixel mask into three RGB24 mask bytes. For that
binary contract, `image & ~(mask - 1)` applies the mask without converting the
HWC/AoS image to SoA. The staged record rises from 5460 iterations/s for SoA to
6828 for AVX2 over the original AoS, before parallel variants; the full reported
66x versus NumPy combines several transformations and must not be attributed to
the shuffle alone.

For packed output, shape a macroblock so stores are full and contiguous.
`parallel101/simdtutor/result/rgba2rgb.cpp` evolves from compacting each RGBA
vector independently to shuffling and blending four 16-byte inputs into exactly
three 16-byte RGB stores. Its record moves from 23.16 GB/s scalar to 32.43 GB/s.
Respect lane-local shuffle semantics, byte order, aliasing, and output capacity.
The example's unsigned `(n - width)` loop bound is unsafe for tiny inputs; adapt
it with a guarded bound before reusing the mechanism.

## Compact selected lanes with a LUT

AVX2 has comparisons, lane permutation, masked stores, movemask extraction, and
popcount, but no direct packed `compress-store`. The bundled
`parallel101/simdtutor/source/filterp.cpp` combines them into a stable stream
compaction kernel:

1. Compare eight input floats and extract the lane predicate as an 8-bit mask.
2. Use that mask to index a 256-entry permutation table. The selected lane
   indices appear first and remain in input order.
3. Permute the vector once, then use the paired prefix-store mask to write only
   the selected lane count.
4. Advance the output pointer by `popcount(mask)` and repeat. The example handles
   two vectors per iteration to overlap independent work.

This replaces per-lane unpredictable branches and scattered writes with one
data-dependent table lookup, a register permute, and a contiguous masked store.
Each mask owns two 32-byte table records, so the complete AVX2 LUT occupies
16 KiB. That footprint, its L1 residency, mask density, store behavior, and the
cost of competing table users all belong in the benchmark—not in an assumption.

Preserve the kernel's invariants when adapting it:

- initialize and align the LUT before concurrent use;
- keep the permutation and prefix-store records paired with the same mask;
- count the original 8-bit mask, even if an encoded table byte offset is used;
- prove output capacity and the input/output non-aliasing contract;
- test empty input, every mask pattern, non-multiple tails, NaNs, and ordering;
- retain a scalar reference and compare both returned count and output sequence.

On AVX-512, use `compress-store` as the primary candidate; on SVE and newer
portable SIMD facilities, evaluate their native compaction operations. The LUT
technique remains valuable when the deployed ISA lacks compress, but it is an
ISA-specific solution rather than a universal abstraction.

## Speculate on the common outcome and replay rare hits

When matches are rare, make the hot path answer only “does this block contain
anything?” `parallel101/simdtutor/result/findp.cpp` compares 16 floats, ORs four
comparison vectors lane-wise, and extracts one coarse movemask. Only on a hit
does it reload and recompare the block, concatenate exact masks, and count
trailing zeros to locate the first match.

For its rare-match distribution, the recorded progression improves from 251 ns
for a four-wide scan to 180 ns for coarse scan plus cold replay; scalar is
749 ns. This is profitable speculation, not free work: frequent or early hits
make replay expensive. Benchmark the real hit-position distribution, preserve
ordered comparison/NaN semantics, dispatch or replace ISA-specific bit-scan
operations, and return absence through a type-safe API.

## Break reduction dependency chains

A scalar `sum += x[i]` is one long recurrence: the next add cannot complete
until the previous sum is ready. SIMD alone turns it into several lane-local
recurrences, but one vector accumulator still has a loop-carried dependency.
Unrolling twice into that same accumulator does not remove it—the second vector
add depends on the first.

The progression in `parallel101/simdtutor/result/sum.cpp` isolates the effective
transformation:

1. Replace the scalar accumulator with one four-lane vector accumulator.
2. Process two vectors per iteration into two independent accumulators.
3. Combine the accumulators only after the main loop.
4. Perform the horizontal reduction once, then handle the scalar tail.

Its recorded experiment moved from 7741 ns scalar to 1933 ns with one vector
accumulator. Merely unrolling two vector adds into that same accumulator stayed
at 1937 ns. Giving those adds independent accumulators reached 983 ns. Treat the
numbers as historical evidence, not portable ratios; the important contrast is
that unrolling created instruction-level parallelism only when it also created
independent dependency chains.

Model the choice rather than fixing it at two accumulators. Increase independent
chains until add latency is hidden by issue throughput, then stop before register
pressure, spills, frontend cost, load bandwidth, or memory bandwidth dominates.
The useful count therefore depends on ISA width, operation latency/throughput,
unroll body, surrounding work, and target microarchitecture.

This transformation reassociates the reduction. Floating-point addition is not
associative, so require an error/reproducibility contract rather than invoking an
"addition association law." Compare against a suitable reference tolerance and
consider pairwise, wider, or compensated accumulation when accuracy matters.
For integers, prove accumulator range and signed-overflow behavior. Also inspect
optimized code first: relaxed FP modes, explicit reduction constructs, or modern
compilers may already generate multiple vector accumulators.

## Sweep unroll and accumulator counts

Treat unroll factor `U` and independent accumulator count `A` as separate tuning
variables. For a simple reduction such as `SNRM2`, benchmark at least `U = 1, 2,
4` on representative sizes. First hold `A = 1` to expose the benefit from fewer
loop-control instructions and more scheduled loads; then raise `A` to expose
independent FMA chains. A larger body is useful only when it removes a measured
frontend or dependency limit.

The bundled `blas/snrm2.cpp` processes four vectors per iteration with two
accumulators: vectors 1 and 3 feed one chain, while 2 and 4 feed the other. Keep
that useful point, but also measure one-, two-, and four-chain variants. Stop
increasing `U` or `A` when latency is covered or when code size, decode/uop-cache
pressure, register spills, loads, or memory bandwidth flatten or reverse the
gain. Filling every architectural register is not a goal; the surrounding
kernel still needs registers for pointers, indices, masks, and temporaries.

Keep the experiment controlled: use the same arithmetic and tail policy, inspect
generated assembly for spills and compiler re-unrolling, report cycles/items and
small-size crossover as well as throughput, and validate every association tree
against the numerical contract. The best pair is specific to ISA,
microarchitecture, compiler, flags, and fused surrounding work.

## Handle reductions and horizontal work

Horizontal operations often have lower throughput and create dependencies.
Accumulate vertically across several iterations and reduce lanes once near the
end. For counts and dot products:

- use multiple vector accumulators;
- widen before overflow;
- delay horizontal sums/popcount extraction;
- choose a deterministic or error-bounded reduction policy;
- verify the compiler does not reintroduce a scalar dependency chain.

For sparse masks, compare masked arithmetic, compress/store, movemask+bit scan,
and two-phase index compaction. The best form depends on density and downstream
use.

Horizontal instructions may reduce only inside architectural sublanes. In AVX,
repeating `_mm256_hadd_ps` or `_mm256_hadd_pd` does not by itself combine the two
128-bit halves. Finish with an explicit cross-half extract/add or a verified
compiler idiom, and test patterned lanes whose partial sums differ; symmetric
random data can conceal this class of bug.

## Learn the SDOT DSDOT SNRM2 family

The bundled BLAS trio is a compact curriculum in vector reductions:

- `blas/sdot.cpp` streams two FP32 vectors, uses FMA, and keeps two independent
  accumulators. It establishes the basic dot-product kernel and separates the
  contiguous-load path from the strided-gather path.
- `blas/dsdot.cpp` keeps the same FP32 storage but widens exactly to FP64 before
  FMA. It is the mixed-precision centerpiece: narrow traffic, wider arithmetic
  and accumulation, and an FP64 result.
- `blas/snrm2.cpp` reuses the reduction shape for `sqrt(sum(x*x))`: square with
  FMA in the loop, reduce once, and perform the scalar square root only at the
  end. Production norms should use a scaled sum-of-squares algorithm when input
  range can make the naive squares overflow or underflow.

Across all three, accumulate vertically for many iterations, use enough
independent chains to cover FMA latency, combine chains once, cross the 128-bit
AVX half boundary explicitly, then handle the scalar tail. Dispatch unit stride
to contiguous loads; use gather for arbitrary positive strides only when it wins
against scalar code or packing on the measured machine.

When adapting the historical `snrm2.cpp`, repair the strided-path transcription
from `X3 * X4` to `X4 * X4`. Test each lane with distinct magnitudes, exercise
zero/tiny/tail sizes and strides separately, and set tolerances from a numerical
error model rather than multiplying a loose constant by `n`. These checks retain
the optimization lesson while making the implementations trustworthy.

## Vectorize strided streams with indexed gathers

For a logical stream `base[k * stride]`, build one reusable lane-index vector:

```text
lane   = [0, 1, ..., W - 1]
index  = lane * stride
value  = gather(base, index, sizeof(element))
base  += W * stride
```

The `SDOT`, `DSDOT`, and `SNRM2` examples use this pattern to preserve lane
parallelism for non-unit strides while retaining a separate contiguous-load fast
path for `stride == 1`. For an unrolled body, reuse the same index vector and
offset each gather base by `j * W * stride`; advance the base once by
`U * W * stride` after the block. Construct indices outside the hot loop and
dispatch the stride case outside it as well.

For x86 `i32gather`, prove that every scaled signed 32-bit offset is representable
and that the intrinsic scale matches the element size. Define the API convention
for zero and negative strides before doing pointer arithmetic. Benchmark gather
against scalar traversal and, when data is reused, explicit packing: gather is a
smart expression of irregular lane addresses, not a promise of one-load
throughput. Its cost follows cacheline/page dispersion and target
microarchitecture.

## Handle tails tiny inputs and alignment

Every vector kernel needs defined behavior for:

- zero and sizes smaller than one vector;
- non-multiple tails;
- unaligned input/output permitted by the API;
- page boundaries and legal over-read/over-write;
- input/output aliasing and in-place operation.

Use masked tails when supported and profitable, or a tested scalar cleanup.
Never form an end pointer by subtracting a vector width from an unsigned size
before checking the size.

Let the vectorized block size be `B = vector_width * unroll_factor`. Compute:

```text
bulk = floor(n / B) * B
run the vector kernel over [0, bulk)
run a masked or scalar cleanup over [bulk, n)
```

For power-of-two `B`, `bulk = n & ~(B - 1)` and `tail = n & (B - 1)` are valid
only after establishing a nonnegative integer `n`. This is the pattern used by
the BLAS examples: the main loop advances its pointers through complete blocks,
then the same advanced pointers consume the remaining elements with the original
strides. Guard `n <= 0` according to the API before forming end pointers.

Test `n = 0` through `B + 1`, every remainder modulo `B`, multiple full blocks,
unit and non-unit strides, each permitted alignment, and buffers ending at a
guard page. Use output sentinels to detect an accidental over-store. A tail that
is correct only for multiples of SIMD width is not a tail implementation.

Peeling to alignment is worthwhile only if aligned access measurably helps and
the remaining loop is long enough. Modern x86 unaligned accesses within a
cacheline are often efficient; crossing cache/page boundaries can still matter.

## Choose intrinsics only with evidence

Use intrinsics when the compiler cannot express or discover a profitable
operation such as a specific byte shuffle, saturating narrow, mask extraction,
or multiversioned kernel. Keep:

- a clear scalar/reference implementation;
- correctness tests shared by every path;
- a benchmark demonstrating the win and crossover;
- comments describing lane layout and invariants, not narrating syntax;
- a narrow ISA-specific implementation boundary.

Do not assume hand-written SIMD beats autovectorization. Intrinsics can block
future ISA selection, increase register pressure, and preserve yesterday's
microarchitecture assumptions.

The bundled `parallel101/simdtutor/result/saxpy.cpp` is a useful negative
control. Its ordinary optimized loop records 1466 ns, while `restrict`, aligned
loads, and hand-written four-wide SIMD remain around 1488–1527 ns. Only a
two-vector unroll reaches 1302 ns, a modest gain consistent with exposing more
memory-level parallelism in a bandwidth-heavy loop. Use the compiler's loop as
the baseline; alignment and intrinsics are contracts/tools, not speed tokens.

## Dispatch across ISAs

Provide a scalar baseline and optional ISA variants. Select once per buffer,
batch, or operation—not per element.

Possible mechanisms include separate translation units with target flags,
function target attributes/multiversioning, platform dispatch libraries, or a
factory-resolved function pointer. In every case:

- detect OS-enabled features, not only nominal CPU bits;
- keep signatures and alias contracts identical;
- test each variant directly on supported hardware;
- compare results under the numerical contract;
- define fallback behavior for unsupported targets;
- benchmark dispatch overhead at small sizes;
- avoid compiling the entire binary for the highest local ISA by accident.

Treat AVX2 examples as examples. Design the algorithm around vectors and blocks
so AVX-512, NEON/SVE, or portable SIMD backends can be added without exposing
ISA types across the application.
