// bench/verify.mjs — behavioural assertions on the real sample mesh.
import { readFileSync } from "node:fs";
import {
  readGltfMesh, meshStats, weld, simplifyQEM,
  clusteringToTarget, hausdorff, sampleSurface,
} from "../src/core.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}  ${detail}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail}`); }
};

const gltf = JSON.parse(readFileSync(new URL("../data/mesh.gltf", import.meta.url), "utf8"));
const mesh = readGltfMesh(gltf);
const st = meshStats(mesh);

ok("parse.triangles", st.triangles === 12288, `triangles=${st.triangles} expected=12288`);
ok("parse.vertices", st.vertices === 6144, `vertices=${st.vertices} expected=6144`);
ok("parse.diagonal", Math.abs(st.diagonal - 9.4401) < 0.01, `diagonal=${st.diagonal.toFixed(4)} expected≈9.4401`);

const w = weld(mesh, 1e-9);
ok("weld.no_duplicates", w.merged === 0, `merged=${w.merged} (mesh is already welded)`);

const t0 = performance.now();
const q = simplifyQEM(mesh, 0.06);
const qemMs = performance.now() - t0;

ok("qem.triangle_budget", q.triangles >= 700 && q.triangles <= 780,
  `triangles=${q.triangles} budget=736±44`);
ok("qem.vertices", q.vertices > 0 && q.vertices < st.vertices, `vertices=${q.vertices} < ${st.vertices}`);
ok("qem.collapses", q.collapses > 4000, `collapses=${q.collapses}`);
ok("qem.indices_in_range", q.indices.every((i) => i < q.vertices), `maxIndex=${Math.max(...q.indices)} < ${q.vertices}`);
let degenerate = 0;
for (let f = 0; f < q.indices.length; f += 3) {
  const a = q.indices[f], b = q.indices[f + 1], c = q.indices[f + 2];
  if (a === b || b === c || a === c) degenerate++;
}
ok("qem.no_degenerate_faces", degenerate === 0, `degenerate=${degenerate}`);

const q2 = simplifyQEM(mesh, 0.06);
let identical = q2.positions.length === q.positions.length && q2.indices.length === q.indices.length;
for (let i = 0; identical && i < q.positions.length; i++) if (q2.positions[i] !== q.positions[i]) identical = false;
for (let i = 0; identical && i < q.indices.length; i++) if (q2.indices[i] !== q.indices[i]) identical = false;
ok("qem.deterministic", identical, `two runs byte-identical=${identical}`);

const cl = clusteringToTarget(mesh, q.triangles);
ok("baseline.triangle_budget", cl.mesh.triangles <= q.triangles * 1.3,
  `clustering=${cl.mesh.triangles} vs qem=${q.triangles} (<= ${Math.round(q.triangles * 1.3)})`);

const hq = hausdorff(mesh, q, 600, 7);
const hc = hausdorff(mesh, cl.mesh, 600, 7);

ok("quality.qem_mean_error", hq.meanPct < 0.6,
  `mean=${hq.meanPct.toFixed(3)}% of diagonal (< 0.6%)`);
ok("quality.qem_max_error", hq.maxPct < 2.5,
  `max=${hq.maxPct.toFixed(3)}% (< 2.5%)`);
ok("quality.qem_beats_baseline", hq.meanPct * 1.3 < hc.meanPct,
  `qem=${hq.meanPct.toFixed(3)}% vs clustering=${hc.meanPct.toFixed(3)}% (${(hc.meanPct / hq.meanPct).toFixed(2)}x, clustering has ${(100 * (cl.mesh.triangles / q.triangles - 1)).toFixed(1)}% more triangles)`);

const s1 = sampleSurface(mesh, 64, 42);
const s2 = sampleSurface(mesh, 64, 42);
let sameSamples = true;
for (let i = 0; i < s1.length; i++) if (s1[i] !== s2[i]) { sameSamples = false; break; }
ok("sampling.deterministic", sameSamples, `seed=42 twice identical=${sameSamples}`);

ok("perf.qem_under_cap", qemMs < 1500, `qem=${qemMs.toFixed(1)}ms (< 1500ms)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
