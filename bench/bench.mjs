// bench/bench.mjs — cold start + 5 timed repetitions, median/p95/stddev.
import { readFileSync, writeFileSync } from "node:fs";
import {
  readGltfMesh, meshStats, simplifyQEM, clusteringToTarget, hausdorff,
} from "../src/core.mjs";

const RAW = JSON.parse(readFileSync(new URL("../data/mesh.gltf", import.meta.url), "utf8"));

function stats(samples) {
  const s = samples.slice().sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return {
    samples: s.map((x) => +x.toFixed(3)),
    min: +s[0].toFixed(3),
    median: +median.toFixed(3),
    p95: +s[Math.min(n - 1, Math.floor(0.95 * n))].toFixed(3),
    stddev: +stddev.toFixed(3),
    relStddev: +(100 * stddev / (median || 1)).toFixed(2),
  };
}

function time(fn) {
  const t = performance.now();
  const v = fn();
  return [performance.now() - t, v];
}

// ---- cold start: very first execution of the whole pipeline ----
const coldT0 = performance.now();
const coldMesh = readGltfMesh(RAW);
const coldQ = simplifyQEM(coldMesh, 0.06);
const coldCl = clusteringToTarget(coldMesh, coldQ.triangles);
const coldHq = hausdorff(coldMesh, coldQ, 600, 7);
const coldHc = hausdorff(coldMesh, coldCl.mesh, 600, 7);
const coldStartMs = performance.now() - coldT0;

// ---- warmup ----
{
  const m = readGltfMesh(RAW);
  const q = simplifyQEM(m, 0.06);
  const c = clusteringToTarget(m, q.triangles);
  hausdorff(m, q, 600, 7);
  hausdorff(m, c.mesh, 600, 7);
}

const REPEATS = 5;
const parseMs = [], qemMs = [], clusterMs = [], errQemMs = [], errClMs = [];
let mesh = null, qem = null, cluster = null, hq = null, hc = null;

for (let r = 0; r < REPEATS; r++) {
  const [tp, m] = time(() => readGltfMesh(RAW));
  parseMs.push(tp);
  const [tq, q] = time(() => simplifyQEM(m, 0.06));
  qemMs.push(tq);
  const [tc, c] = time(() => clusteringToTarget(m, q.triangles));
  clusterMs.push(tc);
  const [te, e] = time(() => hausdorff(m, q, 600, 7));
  errQemMs.push(te);
  const [tf, f] = time(() => hausdorff(m, c.mesh, 600, 7));
  errClMs.push(tf);
  mesh = m; qem = q; cluster = c; hq = e; hc = f;
}

const st = meshStats(mesh);
const result = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  input: {
    file: "data/mesh.gltf",
    vertices: st.vertices,
    triangles: st.triangles,
    diagonal: +st.diagonal.toFixed(4),
  },
  config: { targetRatio: 0.06, repeats: REPEATS, hausdorffSamples: 1200 },
  coldStartMs: +coldStartMs.toFixed(3),
  metrics: {
    parse: stats(parseMs),
    qemSimplify: stats(qemMs),
    clusteringBaseline: stats(clusterMs),
    hausdorffQem: stats(errQemMs),
    hausdorffClustering: stats(errClMs),
  },
  output: {
    qem: { triangles: qem.triangles, vertices: qem.vertices, collapses: qem.collapses },
    clustering: { triangles: cluster.mesh.triangles, vertices: cluster.mesh.vertices, resolution: cluster.resolution },
    triangleReductionPct: +(100 * (1 - qem.triangles / st.triangles)).toFixed(2),
  },
  quality: {
    qem: { meanPct: +hq.meanPct.toFixed(4), maxPct: +hq.maxPct.toFixed(4), p95Pct: +hq.p95Pct.toFixed(4) },
    clustering: { meanPct: +hc.meanPct.toFixed(4), maxPct: +hc.maxPct.toFixed(4), p95Pct: +hc.p95Pct.toFixed(4) },
    meanErrorRatio: +(hc.meanPct / hq.meanPct).toFixed(3),
    clusteringExtraTrianglesPct: +(100 * (cluster.mesh.triangles / qem.triangles - 1)).toFixed(2),
  },
};

writeFileSync(new URL("./result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");

const m = result.metrics;
console.log(`input            ${st.vertices} verts / ${st.triangles} tris / diag ${st.diagonal.toFixed(3)}`);
console.log(`cold start       ${result.coldStartMs} ms (full pipeline, first run)`);
console.log(`parse            median ${m.parse.median} ms  (min ${m.parse.min}, p95 ${m.parse.p95}, sd ${m.parse.stddev})`);
console.log(`QEM simplify     median ${m.qemSimplify.median} ms  (min ${m.qemSimplify.min}, p95 ${m.qemSimplify.p95}, sd ${m.qemSimplify.stddev}, rel ${m.qemSimplify.relStddev}%)`);
console.log(`clustering       median ${m.clusteringBaseline.median} ms`);
console.log(`hausdorff (QEM)  median ${m.hausdorffQem.median} ms`);
console.log(`output QEM       ${qem.triangles} tris (-${result.output.triangleReductionPct}%), mean err ${hq.meanPct.toFixed(3)}%`);
console.log(`output cluster   ${cluster.mesh.triangles} tris, mean err ${hc.meanPct.toFixed(3)}%`);
console.log(`quality ratio    clustering is ${result.quality.meanErrorRatio}x worse with +${result.quality.clusteringExtraTrianglesPct}% triangles`);
console.log(`\nwrote bench/result.json`);
