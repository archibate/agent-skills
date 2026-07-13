# Ragged Topology and Flat Variable-Length Data

## Contents

- [Replace nested ownership with flat ranges](#replace-nested-ownership-with-flat-ranges)
- [Do not confuse inline capacity with flattening](#do-not-confuse-inline-capacity-with-flattening)
- [Keep identity and topology in sidecar arrays](#keep-identity-and-topology-in-sidecar-arrays)
- [Treat polygon faces as compressed corner adjacency](#treat-polygon-faces-as-compressed-corner-adjacency)
- [Build variable output with count scan scatter](#build-variable-output-with-count-scan-scatter)
- [Guard the coupled invariants](#guard-the-coupled-invariants)
- [Source boundaries](#source-boundaries)

Use a flat value stream plus range metadata for many variable-length records.
This is the same structural idea behind CSR rows, adjacency lists, grid buckets,
and n-gon mesh faces.

## Replace nested ownership with flat ranges

A logical `vector<vector<Index>>` pays for one vector control block and usually
one allocation per record. Its payloads are scattered, capacity is duplicated,
and traversal repeatedly loads pointers. Model three encodings for `F` records
and `C` total values:

```text
nested:        C indices + F vector objects + up to F allocations/capacities
start-length:  C indices + 2F offsets
offset-only:   C indices + (F + 1) offsets
```

Use start-length pairs when records may reference independent slices, contain
gaps, or be reordered without rebuilding a prefix array. Use offsets when the
records form one canonical contiguous partition:

```text
record i = values[offsets[i] .. offsets[i + 1])
```

Offsets encode each end as the next start, save one integer per record, and feed
directly into spans, scans, and device kernels. Select 32- or 64-bit offsets from
the maximum total value count, not from habit.

## Do not confuse inline capacity with flattening

A small/inlined vector removes its heap allocation only while one record fits
the inline capacity. It does not turn many records into one contiguous stream.
For `vector<InlinedVector<Index, K>>`, account for:

- a control block and `K` reserved slots in every outer element, including short
  and empty records;
- a larger outer stride, so fewer record descriptors fit in each cacheline;
- unused inline capacity under a skewed length distribution;
- separate allocations and an inline-versus-spilled branch for records longer
  than `K`;
- copied or moved inline payload when the outer vector itself relocates.

`map<Key, InlinedVector<Index, K>>` adds node allocations, links, key storage,
and branchy tree traversal. Embedding `K` values makes every node larger. This
may improve mutation or one-record lookup latency when most records are tiny,
but it does not provide the sequential value stream wanted by a memory-bound
read-many kernel.

For that hot traversal, prefer one `values` vector plus `offsets[records + 1]`.
For a sparse keyed collection, use sorted `keys`, `offsets`, and `values`, or map
each key to a dense row index while keeping the ragged payload flat. This gives
exact-sized storage, predictable prefetch, cheap bulk transfer, and a natural
range per row:

```text
row i = values[offsets[i] .. offsets[i + 1])
```

Separate the build and query representations when edits genuinely need small
mutable buckets: build rows independently, count their final lengths,
exclusive-scan the counts, copy or move them into one exact allocation, then
discard the builders. Benchmark the production row-length distribution and
working-set size; small-buffer optimization attacks allocation latency, whereas
CSR-style flattening attacks hot-loop footprint and locality.

## Keep identity and topology in sidecar arrays

Separate the dense payload from the metadata that locates or connects it. Face
offsets and corner indices describe mesh topology without occupying lanes in the
vertex array. A vertex-only transform therefore streams `verts` directly and
never reads face topology; a face kernel opts into the sidecar arrays. Inline
per-record storage cannot do this: its empty capacity and control state remain
interleaved with enumeration even when the kernel needs only the values.

The ECS sparse set applies the same principle to stable external IDs and mutable
dense storage. In generic names it contains:

```text
values[denseIndex]       -> payload
idToDense[id]            -> denseIndex, or absent
denseToId[denseIndex]    -> id
```

Maintain these invariants:

```text
values.size == denseToId.size
idToDense[denseToId[i]] == i
value(id) == values[idToDense[id]]
```

Insertion appends an ID and value, then records their dense index. Deletion
looks up the dense slot, swap-removes the last value and ID into that slot, and,
if an element moved, changes only `idToDense[movedId]` to the repaired slot.
Lookup, insertion, and unordered deletion are O(1), while system iteration walks
the packed `values` stream without holes, tombstones, or ID-space scanning. The
trade is deliberately unstable dense order; use a separate ordering sidecar or
another representation when stable iteration order is part of the contract.

Bevy names these arrays `dense`, `sparse`, and `indices`, respectively: its
`dense[sparse[id]]` is the value, and `indices[denseIndex]` recovers the ID.
Guard stale reusable IDs with a generation/version invariant. Also account for
the sparse map's ID range: a flat `idToDense` array is ideal for compact IDs but
can waste memory for a huge sparse namespace; use a paged sparse array or hash
ID-to-dense map while retaining dense payload and reverse-ID arrays when needed.

Use this as a general data-oriented ownership pattern for ECS components,
particles, active objects, resource handles, and mutable graph subsets: keep the
hot values packed, and move identity, connectivity, and edit bookkeeping to
sidecar topology that only the relevant operation loads.

## Treat polygon faces as compressed corner adjacency

The valuable core of Zeno's `PrimitiveObject` separates three domains:

- `verts`: dense vertex positions and vertex-domain attributes;
- `loops`: one flat vertex index per face corner;
- `polys`: one `(start, length)` pair per face, slicing `loops`.

This represents arbitrary n-gons without an allocation per face. It is better
described as compressed ragged topology or CSR-like vertex adjacency than as a
sparse matrix. A vertex may appear in many corners, while each corner is owned by
exactly one face.

The corner domain is essential, not redundant metadata. UV seams, split normals,
corner colors, and per-face-corner edge references may differ even when two
corners point to the same vertex. Keep attribute columns aligned by domain:

```text
vertex attributes size == vertex count
corner attributes size == flat corner-index count
face attributes   size == face count
```

Legacy Blender used the same `MLoop` plus `MPoly{loopstart, totloop}` shape.
Current Blender goes further: `corner_verts` remains flat while
`face_offset_indices[F+1]` encodes every contiguous face range. Prefer this
offset-only form for a newly designed canonical mesh; retain start-length pairs
when independent slices are a real requirement.

## Build variable output with count scan scatter

Zeno's polygon triangulation composes the representation with parallel scan:

1. compute `max(faceLength - 2, 0)` output triangles per face;
2. exclusive-scan those counts into disjoint output ranges;
3. resize the triangle and mapping arrays exactly once;
4. process faces in parallel and write only to each face's assigned range;
5. use the mapping to replicate face attributes and remap corner attributes.

This is count–scan–scatter applied to a ragged topology transform. It avoids
concurrent append and allocation while preserving deterministic face order. The
simple triangle-fan expansion is correct for suitable planar convex polygons;
general concave or non-planar n-gons require a robust tessellator and a declared
winding/degeneracy policy.

Apply the same construction to polygon subdivision, adjacency generation,
particle-to-cell lists, graph frontier expansion, and sparse assembly. Read
`parallelism-and-pipelines.md` for the scan/scatter and grid-binning cost model.

## Guard the coupled invariants

Encapsulate topology mutation in a value type even when the hot arrays remain
plain and contiguous. Validate at construction and after bulk transforms:

- offsets start at zero, are nondecreasing, and end at the value count; or every
  start-length range lies inside the value stream;
- a canonical start-length representation has no gaps or overlaps unless its
  contract explicitly permits them;
- every corner vertex index is in range;
- every domain attribute has exactly its domain's length;
- derived triangle, edge, adjacency, and acceleration caches are invalidated or
  rebuilt after topology changes.

Append, erase, reorder, and compact all coupled columns through one operation.
Do not expose unrelated resizes that can silently desynchronize faces, corners,
and attributes. Give kernels read-only spans/ranges after the invariant is
established, and keep construction/editing machinery outside the hot traversal.

## Source boundaries

Study the data fields in Zeno's
[`PrimitiveObject.h`](https://github.com/zenustech/zeno/blob/bacf3c51f5a35a0da892c1336ed6dd725b1fd5d8/zeno/include/zeno/types/PrimitiveObject.h)
and the scan-sized output in
[`PrimitiveTriangulate.cpp`](https://github.com/zenustech/zeno/blob/fb39e1faca90cce40680e2124886491e620edd1b/zeno/src/nodes/prim/PrimitiveTriangulate.cpp).
Exclude the unrelated header-level polygon helper functions from this lesson.
Zeno is MPL-2.0, so link and paraphrase it rather than copying those files into
the CC-licensed Parallel101 corpus.

Compare the legacy and current layouts in Blender's
[`DNA_meshdata_types.h`](https://github.com/blender/blender/blob/main/source/blender/makesdna/DNA_meshdata_types.h)
and [`DNA_mesh_types.h`](https://github.com/blender/blender/blob/main/source/blender/makesdna/DNA_mesh_types.h).

For dynamic dense membership, study Bevy's
[`SparseSet`](https://github.com/bevyengine/bevy/blob/8ae14b2eb8fb19bdb7424d20de2ee495e8988f84/crates/bevy_ecs/src/storage/sparse_set.rs),
especially the `dense`, `indices`, and `sparse` fields and the swap-remove repair
in `remove`. Link and paraphrase the implementation rather than bundling it.
