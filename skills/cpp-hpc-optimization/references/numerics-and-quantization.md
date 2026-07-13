# Numerics and Quantization

## Contents

- [Define the numerical contract](#define-the-numerical-contract)
- [Separate storage, compute, and accumulation](#separate-storage-compute-and-accumulation)
- [Use DSDOT as a mixed-precision archetype](#use-dsdot-as-a-mixed-precision-archetype)
- [Understand reduced floating-point formats](#understand-reduced-floating-point-formats)
- [Use integer quantization deliberately](#use-integer-quantization-deliberately)
- [Use narrowing experiments as range proofs](#use-narrowing-experiments-as-range-proofs)
- [Use shared exponent formats by block](#use-shared-exponent-formats-by-block)
- [Control reductions and reproducibility](#control-reductions-and-reproducibility)
- [Distinguish deterministic trees from accurate sums](#distinguish-deterministic-trees-from-accurate-sums)
- [Validate a precision change](#validate-a-precision-change)

## Define the numerical contract

Reduced precision is an algorithm change. Before selecting a representation,
record:

- expected and adversarial value ranges and distributions;
- absolute, relative, ULP, domain-specific, or final-output error bounds;
- handling of zero, subnormals, overflow, NaN, Inf, and signed zero;
- whether values may saturate, clamp, flush, or become nondeterministic;
- whether accumulation order and bitwise reproducibility matter;
- calibration lifetime: global, per tensor, per channel, per block, or dynamic.

Test the final observable result, not only round-trip encoding error. Small local
errors can amplify through iteration, cancellation, normalization, or branching.

## Separate storage, compute, and accumulation

These are independent decisions:

- **Storage precision** controls footprint and memory traffic.
- **Compute precision** controls instruction availability, throughput, and local
  rounding.
- **Accumulation precision** controls error growth and overflow across many
  terms.

A common design stores FP16/BF16 or integers, widens to FP32 for arithmetic, and
uses FP32 or FP64 for sensitive accumulation. The conversion cost may be hidden
or outweighed by saved bandwidth, but only a workload measurement decides.

Use pairwise/tree reduction, compensated summation, or wider accumulation when
the error contract requires it. Avoid widening everything by instinct: wider
lanes can reduce SIMD width and increase traffic.

## Use DSDOT as a mixed-precision archetype

BLAS `DSDOT` is an elegant mixed-precision contract: keep both operand streams as
compact `float`, widen each loaded value exactly to `double`, then multiply and
accumulate in `double`. It spends bandwidth at FP32 density while protecting a
long dot product with FP64 arithmetic. This cleanly demonstrates that storage,
compute, accumulation, and result precision are independent design choices.

`parallel101/simdtutor/blas/dsdot.cpp` makes that contract concrete with SIMD
widening, FMA, a fast contiguous path, a gather path for non-unit strides, and
two independent double-vector accumulators to hide dependency latency. Widening
halves the AVX lane count relative to `SDOT`, so measure whether accuracy,
bandwidth, conversion throughput, or FMA throughput controls the real kernel.

Preserve the lesson while repairing the historical final reduction: AVX
horizontal-add instructions operate inside 128-bit halves, so explicitly combine
the halves before extracting the scalar. Validate with asymmetric lane patterns,
cancellation, large dynamic range, NaN/Inf, supported stride signs, and a
long-double or higher-quality oracle. Wider accumulation greatly improves error
growth, although it does not promise correct rounding or bitwise reproducibility.

## Understand reduced floating-point formats

**IEEE binary16 (FP16)** has limited exponent range and about three decimal
digits of precision. It can overflow or underflow data that BF16 represents.

**bfloat16 (BF16)** retains FP32-like exponent range but has fewer fraction bits.
It is often useful for wide-range values where coarse mantissa precision is
acceptable.

Do not implement BF16 by violating strict aliasing or blindly discarding the low
16 bits. Define rounding—usually round-to-nearest-even—preserve special values,
and use `std::bit_cast` or supported conversion instructions/libraries. Storage
support, conversion instructions, and native arithmetic support are different
hardware capabilities.

Measure conversion throughput and whether the compiler/device keeps values in a
wider representation between loads and stores. Avoid repeated narrow/widen
cycles between fused stages.

## Use integer quantization deliberately

A typical affine representation is:

```text
real ~= scale * (quantized - zero_point)
```

Symmetric quantization omits or fixes the zero point. Decide:

- signed versus unsigned range;
- scale derivation and calibration dataset;
- per-tensor, per-channel, or per-block scales;
- rounding mode;
- saturation versus wraparound;
- widened intermediate and accumulator widths;
- dequantization point and fused operations.

Prove maximum intermediate and reduction ranges. Narrow multiplication often
needs a wider product, and many products need an even wider accumulator. Treat
integer overflow as a correctness defect, not a performance technique.

Packing below byte width saves storage but adds extraction, masking, alignment,
and tail cost. It is strongest when data stays packed across several stages or
when a native dot-product/unpack instruction matches the format.

## Use narrowing experiments as range proofs

`parallel101/course/10/05/` provides a footprint ladder for `2^28` logical
flags: int64 is about 2 GiB, int about 1 GiB, int8 about 256 MiB, and one-bit
storage about 32 MiB. Crossing a cache/TLB/bandwidth boundary can dominate the
extra packing instructions. Compare the actual reads, writes, updates, scans,
atomics, and decode work; the examples time allocation plus predictable first
touch, not the full application. Use unsigned bytes for manual bit packing and
treat `vector<bool>` proxy/concurrency semantics explicitly.

`parallel101/course/10/06/` is a failed-but-useful quantization progression. Its
int8 scale overflows the demonstrated range, the uint8 codec is stored in an
int8 vector, conversions truncate without a rounding/saturation policy, and the
BF16-like version uses illegal aliasing and signed shifts while discarding low
bits. Rebuild the experiment from calibrated range, scale/zero point, defined
rounding and saturation, correct signedness, `std::bit_cast` or native BF16
conversion, and representative error metrics. Saving bytes is the result of a
range/error proof, not of changing the element type.

## Use shared exponent formats by block

Block floating point/shared exponent stores one exponent or scale for a group of
mantissas. It reduces metadata and enables dense integer-like arithmetic, but a
single outlier can reduce precision for the whole block.

Design choices include:

- block shape aligned with access, SIMD lanes, tiles, or sparse blocks;
- exponent selection from maximum magnitude, percentile, or robust calibration;
- signed mantissa width and headroom for accumulation;
- rescaling frequency and handling of zeros/outliers;
- whether neighboring blocks need conversion before combined operations;
- metadata layout and vectorized encode/decode.

Smaller blocks track local range better but spend more bytes and work on scales.
Larger blocks compress metadata but increase outlier sensitivity. Include scale
traffic in the memory model and calibration in the latency model.

For addition, align exponents before adding and account for shifted-away bits.
For reductions, accumulate in a wider domain or periodically renormalize with a
defined rounding policy. Validate pathological blocks containing one extreme
value plus many small values.

## Control reductions and reproducibility

Floating-point addition is not associative. SIMD, unrolling, work stealing,
thread count, and accelerator reduction trees can change the result.

Choose and document one policy:

- accept bounded nondeterminism for throughput;
- use a fixed reduction tree for repeatability;
- use wider or compensated accumulation for accuracy;
- use exact/superaccumulator techniques when the domain truly requires them.

Do not compare a parallel floating result with exact equality unless bitwise
identity is part of the contract and the implementation guarantees it.

Relaxed math flags can reassociate expressions, ignore errno/exceptions, assume
no NaN/Inf, or use approximate operations. Enable only the specific assumptions
the numerical contract allows, and test the deployed compiler flags.

## Distinguish deterministic trees from accurate sums

`parallel101/course/06/02_reduce/03` and `04` contrast a scheduler-dependent TBB
reduction with `parallel_deterministic_reduce`, whose split/combine tree is stable
for repeated equivalent invocations. Deterministic means repeatable under that
runtime/configuration; it does not mean serial-equivalent, correctly rounded, or
bitwise portable across TBB versions, partitioners, compilers, ISAs, or hardware.

Choose reproducibility and accuracy separately. Test repeated runs and thread
counts, compare against serial and higher-precision or compensated references,
and record the exact partition/tree configuration when bitwise stability is part
of the contract. The course pair prints results but contains neither a timing
comparison nor a high-precision oracle, so reproduce both before choosing.

## Validate a precision change

1. Preserve the full-precision reference path.
2. Test realistic distributions and adversarial extremes.
3. Report absolute, relative, percentile, maximum, and domain-level error as
   appropriate; inspect where maxima occur.
4. Test long iterations and reductions, not only one operation.
5. Test encode/decode boundaries, ties, saturation, NaN/Inf, and signed zero.
6. Measure footprint, bytes transferred, conversion cost, vector width, and
   end-to-end time.
7. Record the calibration data and runtime fallback when the range is violated.

Reject a narrower representation if it saves bytes but violates error, creates
expensive scattered metadata, or moves the bottleneck to conversion.
