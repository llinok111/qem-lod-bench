# qem-lod-bench

**One-line promise:** a 12,288-triangle mesh is reduced to **736 triangles (−94.0%)** with **0.384% mean surface error** (of the bounding-box diagonal) in **94.6 ms** — while a grid-vertex-clustering baseline given **22% more triangles** (898) lands at 0.632%, i.e. **1.65× worse**.

Upstream: none

This is an original implementation of quadric-error-metric (QEM) edge-collapse simplification plus a vertex-clustering baseline, written from scratch. three.js r169 is used only as the renderer. It is a head-to-head, error-measured benchmark harness (not just a simplifier): both methods are budgeted to the same target and scored by the same seeded symmetric-Hausdorff routine.

## What it is

- `src/core.mjs` — pure geometry: glTF reader, QEM simplifier, clustering baseline, deterministic area-weighted surface sampling, symmetric sampled Hausdorff error. No three.js, no DOM, no I/O.
- `main.js` + `index.html` — a three.js viewer (pinned CDN importmap) that calls the same core module. Slider sets the triangle budget, toggle switches QEM / clustering, the original mesh stays as a ghost wireframe.
- `data/mesh.gltf` — generated, not committed by hand: a (2,3) torus-knot tube with a fixed radial ripple (6,144 verts / 12,288 tris, 296 KB).

## Run it

```bash
node bench/verify.mjs        # 16 behavioural assertions, exit 0
node bench/bench.mjs         # 5 timed repeats + cold start -> bench/result.json
python3 -m http.server 4173   # then open http://localhost:4173
```

Regenerate the sample (deterministic, byte-identical):

```bash
rm -rf data && node tools/gen-sample.mjs
```

## Evidence (bench/result.json, node v24.19.0)

| metric | value |
| --- | --- |
| input | 6,144 verts / 12,288 tris / bbox diagonal 9.4401 |
| QEM output | 736 tris / 368 verts / 5,776 collapses |
| reduction | **94.01%** |
| QEM mean error | **0.3838%** of diagonal (p95 0.9425%, max 1.5939%) |
| clustering output | 898 tris (+22.01% budget), mean error 0.6321% |
| quality ratio | clustering **1.647× worse** at a larger budget |
| QEM simplify time | median **94.608 ms**, min 83.101, p95 105.805, sd 9.152 (rel. 9.67%) |
| cold start | 1097.213 ms (first full pipeline run, includes module JIT) |

Error is measured by sampling 600 points per direction (1,200 total) area-weighted on the original and on the simplified surface, then taking the symmetric max/mean of nearest-triangle distances, normalised by the original bounding-box diagonal. Sampling is seeded, so the number is reproducible.

`parse` in `bench/result.json` shows a 166.84% relative stddev: its five samples are 0.706, 0.706, 0.718, 0.941 and 3.755 ms, so one slow first pass dominates a sub-millisecond median. It is not part of the claim; the claimed metric (QEM simplify) is at 9.67%.

## Why QEM beats clustering here

Vertex clustering snaps every vertex to a grid cell centroid. On a curved, rippled tube that quantises the surface and destroys the ripple phase; QEM accumulates per-vertex plane quadrics and only collapses edges whose removal costs little, so flat/low-curvature regions collapse first and the ripple is kept. Both are budgeted to the same target and the baseline is allowed 22% more triangles, so the comparison is conservative.

## Known limits

- QEM here is half-edge placement (endpoint or midpoint), not a full 3×3 quadric solve — a full solve would lower the error slightly.
- Only manifold-ish closed meshes are tested; boundary edges are collapsed like interior ones, which can shrink open borders.
- Hausdorff is sampled, not exact: it is an upper-bound estimate with 1,200 samples, deterministic for a fixed seed.
- `data/mesh.gltf` is a single embedded-buffer primitive; the reader does not handle external `.bin`, sparse accessors, or multiple primitives.
- The viewer recomputes on the main thread; at 12k triangles this is ~100 ms, fine for a slider, not for 1M-triangle assets.
