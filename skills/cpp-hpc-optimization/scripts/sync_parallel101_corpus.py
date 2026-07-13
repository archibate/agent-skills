#!/usr/bin/env python3
"""Build the curated, offline Parallel101 teaching corpus for this skill."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


ALLOWED_SUFFIXES = {".cpp", ".cu", ".cuh", ".csv", ".h", ".hpp", ".md", ".txt"}
AUTHOR = "archibate"
LICENSE_ID = "CC-BY-NC-SA-4.0"
REPOSITORY_URLS = {
    "course": "https://github.com/parallel101/course",
    "simdtutor": "https://github.com/parallel101/simdtutor",
}


@dataclass(frozen=True)
class Selection:
    repository: str
    path: str
    classification: str
    purpose: str


def select(repository: str, paths: list[str], classification: str, purpose: str) -> list[Selection]:
    return [Selection(repository, path, classification, purpose) for path in paths]


SELECTIONS = [
    *select(
        "course",
        [
            "README.md",
            "04/3_pointers/01_pointer_aliasing/main.cpp",
            "04/3_pointers/02_restrict_pointer/main.cpp",
            *[
                f"04/5_loops/{lesson}/main.cpp"
                for lesson in (
                    "01_worry_pointer_aliasing",
                    "02_no_pointer_aliasing",
                    "04_no_pointer_aliasing_ivdep",
                    "06_loop_with_external_call",
                    "07_loop_with_inlineable_call",
                    "08_loop_with_random_access",
                    "09_loop_with_skip_access",
                    "10_loop_with_ordered_access",
                    "11_loop_invariant_motion",
                    "12_loop_invariant_failed",
                    "13_loop_unrolling",
                )
            ],
        ],
        "progression",
        "Compiler visibility, aliasing, vectorization, and loop transforms",
    ),
    *select(
        "course",
        [
            *[f"specifelse/{name}.cpp" for name in ("0", "1", "2", "3", "4", "5", "6")],
            "specifelse/ticktock.h",
            "specifelse/randint.h",
            "specifelse/benchtest/demo0.cpp",
        ],
        "progression",
        "Branch prediction, if-conversion, predicates, LUTs, and data-distribution effects",
    ),
    *select(
        "course",
        [
            *[f"04/6_structs/{lesson}/main.cpp" for lesson in (
                "01_vec2_simd_ok",
                "02_vec3_simd_fail",
                "03_vec3_with_padding_ok",
                "04_vec3_with_alignas_ok",
                "05_vec3_aos",
                "06_vec3_soa",
                "07_vec3_aosoa",
            )],
            *[f"04/6_structs/08_benchmark/{name}" for name in (
                "common.h", "profile.h", "main.cpp", "aos.cpp", "aos_aligned.cpp",
                "aos_parallel.cpp", "aosoa.cpp", "soa.cpp", "soa_parallel.cpp",
                "soa_simd.cpp", "soa_size_t.cpp", "soa_unroll.cpp",
            )],
        ],
        "progression",
        "AoS, SoA, AoSoA, padding, alignment, and measured layout trade-offs",
    ),
    *select(
        "course",
        [
            *[f"05/02_async/{lesson}/main.cpp" for lesson in ("01", "02", "03", "04", "05", "06")],
            *[f"06/02_reduce/{lesson}/main.cpp" for lesson in ("03", "04", "08")],
            *[f"06/05_split/{lesson}/main.cpp" for lesson in ("01", "02", "03", "04", "05")],
            *[f"06/08_qsort/{lesson}/main.cpp" for lesson in ("07", "08", "09", "10")],
            *[f"06/09_pipeline/{lesson}/main.cpp" for lesson in ("01", "03", "05")],
        ],
        "progression",
        "Async launch, reductions, grain size, task parallelism, and pipelines",
    ),
    *select(
        "course",
        [
            *[f"06/07_filter/{lesson}/main.cpp" for lesson in (
                "01", "02", "03", "04", "05", "06", "07", "08", "09", "10",
            )],
            *[f"06/07_filter/{lesson}/ticktock.h" for lesson in (
                "01", "02", "03", "04", "05", "06", "07", "08", "09", "10",
            )],
            "06/07_filter/08/pod.h",
            "06/07_filter/10/pod.h",
        ],
        "progression",
        "TBB append, local buffering, atomic publication, and scan-based stream compaction",
    ),
    *select(
        "course",
        [
            *[f"07/01_bandwidth/{lesson}/main.cpp" for lesson in ("01", "02", "03", "04", "05", "06", "07")],
            *[f"07/02_cache/{lesson}/main.cpp" for lesson in ("01", "02", "03", "04")],
            "07/02_cache/04/pseudo.cpp",
            *[f"07/03_prefetch/{lesson}/main.cpp" for lesson in ("01", "02", "03", "04", "05", "06", "07")],
            *[f"07/04_fusion/{lesson}/main.cpp" for lesson in ("00", "01", "02", "03", "04", "05")],
        ],
        "progression",
        "Bandwidth, locality, prefetch, loop tiling, and kernel fusion",
    ),
    *select(
        "course",
        [
            "07/05_malloc/15/main.cpp",
            "07/05_malloc/16/main.cpp",
            "07/06_ndarray/01/main.cpp",
            "07/06_ndarray/01/alignalloc.h",
            "07/06_ndarray/02/main.cpp",
            "07/06_ndarray/03/main.cpp",
            "07/06_ndarray/03/ndarray.h",
            "07/08_matrix/01/main.cpp",
            "07/08_matrix/01/alignalloc.h",
            "07/08_matrix/01/morton.h",
            "07/08_matrix/01/ndarray.h",
            "07/08_matrix/02/main.cpp",
            "07/08_matrix/03/main.cpp",
            "07/09_multicore/01/main.cpp",
        ],
        "reference",
        "Allocation, multidimensional layout, Z-order, and false sharing",
    ),
    *select(
        "course",
        ["07/10_rbgs/01/main.cpp"],
        "reference",
        "Matrix-free red-black Gauss-Seidel stencil and phase dependencies",
    ),
    *select(
        "course",
        [
            "slides/bench/main.cpp", "slides/bench/test.cpp",
            "slides/bench/BM_latency.csv", "slides/bench/BM_struct.csv",
            "slides/design/signal.md", "slides/design/function2.md",
            "slides/design/virtual.md", "slides/design/strict-aliasing.md",
        ],
        "reference",
        "Benchmark interpretation and abstraction cost",
    ),
    *select(
        "course",
        [
            "10/00/bate.h", *[f"10/00/{name}.cpp" for name in ("00", "03", "07", "08", "10")],
            "10/01/bate.h", "10/01/06.cpp",
            "10/04/bate.h", "10/04/06.cpp",
            "10/05/bate.h", *[f"10/05/{name}.cpp" for name in ("00", "01", "02", "03", "04")],
            "10/06/bate.h", *[f"10/06/{name}.cpp" for name in ("03", "04", "05", "06", "07")],
        ],
        "experimental",
        "Sparse representation, quantization, FP16, and shared-exponent lessons",
    ),
    *select(
        "simdtutor",
        [
            "README.md", "practices/dispatch.md", "practices/u8rgba2rgb.md",
            *[f"{side}/{name}.cpp" for side in ("source", "result") for name in (
                "sum", "saxpy", "countp", "findp", "fillsin", "rgba2rgb",
            )],
        ],
        "progression",
        "Scalar-to-SIMD exercises, tails, predicates, and runtime dispatch",
    ),
    *select(
        "simdtutor",
        ["source/filterp.cpp"],
        "experimental",
        "Stable AVX2 stream compaction with movemask, popcount, and permutation LUT",
    ),
    *select(
        "simdtutor",
        ["blas/sdot.cpp", "blas/dsdot.cpp", "blas/snrm2.cpp"],
        "counterexample",
        "Reduction accuracy, dependency chains, and strided SIMD pitfalls",
    ),
    *select(
        "simdtutor",
        [
            "foundation/radixsort/radix_sort.cpp", "foundation/radixsort/show_time.h",
            "foundation/dispatch_kernel.h", "foundation/ScopeProfiler.h",
            "foundation/kernel_rgba2rgb.h", "foundation/kernel_hashrng.h",
            "foundation/cpp17pmrtest/oldmain.cpp", "foundation/cpp17pmrtest/filter.cpp",
            "foundation/moderncuda/README.md", "foundation/moderncuda/cudapp.cuh",
            "foundation/cpplockfreequeue/affinity.h",
            "foundation/cpplockfreequeue/show_time.h",
            "foundation/cpplockfreequeue/spsc_ring.h",
            *[f"foundation/cpplockfreequeue/{name}" for name in (
                "v1_std_mt_queue.cpp", "v2_atomic_ring_queue.cpp",
                "v3_atomic_acq_rel_ring_queue.cpp", "v4_cache_align_ring_queue.cpp",
                "v5_read_pos_cached_ring_queue.cpp", "v6_write_pos_cached_ring_queue.cpp",
                "v7_rw_pos_localize_ring_queue.cpp", "v8_pointer_atomic_ring_queue.cpp",
                "v9_do_while_ring_queue.cpp", "v10_local_variable_ring_queue.cpp",
                "v11_ring_queue_template_class.cpp", "v12_ring_queue_atomic_wait.cpp",
            )],
        ],
        "experimental",
        "Radix sort, dispatch, profiling, allocation, CUDA, and queue evolution",
    ),
    *select(
        "simdtutor",
        [
            "customers/issue4_getsubpixelvalue/old.cpp",
            "customers/issue4_getsubpixelvalue/main.cpp",
            "customers/parallel_multiply_uint8/README.md",
            "customers/parallel_multiply_uint8/fast_mask_lib.hpp",
            "customers/amgcg_vcycle_cuda/README.md",
            "customers/amgcg_vcycle_cuda/rec.txt",
            "customers/amgcg_vcycle_cuda/vcycle.cu",
        ],
        "case-study",
        "Real optimization cases: layout, masks, sparse GPU work, and bottlenecks",
    ),
]


def git_revision(root: Path) -> str:
    return subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assert_within(path: Path, parent: Path) -> None:
    if not path.resolve().is_relative_to(parent.resolve()):
        raise RuntimeError(f"refusing to modify path outside corpus: {path}")


def sync(course_root: Path, simdtutor_root: Path, skill_root: Path, check: bool) -> None:
    roots = {"course": course_root.resolve(), "simdtutor": simdtutor_root.resolve()}
    corpus_root = (skill_root / "references" / "parallel101").resolve()
    revisions = {name: git_revision(root) for name, root in roots.items()}
    expected: set[Path] = set()
    rows: list[str] = []

    duplicate_targets: set[tuple[str, str]] = set()
    for item in SELECTIONS:
        key = (item.repository, item.path)
        if key in duplicate_targets:
            raise RuntimeError(f"duplicate selection: {item.repository}/{item.path}")
        duplicate_targets.add(key)

        source = roots[item.repository] / item.path
        if not source.is_file():
            raise FileNotFoundError(f"missing curated source: {source}")
        if source.suffix.lower() not in ALLOWED_SUFFIXES:
            raise RuntimeError(f"disallowed file type in corpus: {source}")
        if b"\0" in source.read_bytes()[:8192]:
            raise RuntimeError(f"binary file rejected from corpus: {source}")

        target = corpus_root / item.repository / item.path
        assert_within(target, corpus_root)
        expected.add(target)
        digest = sha256(source)
        rows.append("\t".join((
            item.repository,
            AUTHOR,
            REPOSITORY_URLS[item.repository],
            revisions[item.repository],
            item.path,
            item.classification,
            item.purpose,
            LICENSE_ID,
            digest,
        )))
        if check:
            if not target.is_file() or sha256(target) != digest:
                raise RuntimeError(f"corpus is stale: {target}")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)

    provenance = corpus_root / "provenance.tsv"
    expected.add(provenance)
    contents = "\t".join((
        "repository", "author", "source_url", "commit", "source_path",
        "classification", "purpose", "license", "sha256",
    )) + "\n" + "\n".join(rows) + "\n"
    if check:
        if not provenance.is_file() or provenance.read_text() != contents:
            raise RuntimeError(f"corpus provenance is stale: {provenance}")
    else:
        corpus_root.mkdir(parents=True, exist_ok=True)
        provenance.write_text(contents)

    license_source = course_root / "LICENSE"
    license_target = skill_root / "LICENSE"
    if check:
        if not license_target.is_file() or sha256(license_target) != sha256(license_source):
            raise RuntimeError(f"skill license is stale: {license_target}")
    else:
        shutil.copyfile(license_source, license_target)

    if corpus_root.exists():
        stale = sorted(path for path in corpus_root.rglob("*") if path.is_file() and path not in expected)
        if check and stale:
            raise RuntimeError(f"unexpected files in corpus: {', '.join(map(str, stale))}")
        for path in stale:
            assert_within(path, corpus_root)
            path.unlink()
        if not check:
            for path in sorted(corpus_root.rglob("*"), reverse=True):
                if path.is_dir() and not any(path.iterdir()):
                    path.rmdir()

    print(
        f"{'verified' if check else 'synced'} {len(SELECTIONS)} files "
        f"from course@{revisions['course'][:12]} and simdtutor@{revisions['simdtutor'][:12]}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--course-root", type=Path, default=Path.home() / "Projects/course")
    parser.add_argument("--simdtutor-root", type=Path, default=Path.home() / "Projects/simdtutor")
    parser.add_argument(
        "--skill-root", type=Path,
        default=Path(__file__).resolve().parent.parent,
    )
    parser.add_argument("--check", action="store_true", help="verify without modifying files")
    args = parser.parse_args()
    sync(args.course_root, args.simdtutor_root, args.skill_root.resolve(), args.check)


if __name__ == "__main__":
    main()
