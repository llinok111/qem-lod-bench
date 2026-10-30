// tools/gen-sample.mjs — deterministic procedural mesh -> data/mesh.gltf
// Torus-knot tube with a fixed radial ripple. Same command => identical bytes.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const U = 128; // around the knot (closed)
const V = 48;  // around the tube (closed)
const P = 2, Q = 3; // torus knot (p,q)
const TUBE = 0.42;

function curve(t) {
  const c = 2 + Math.cos(Q * t);
  return [c * Math.cos(P * t), c * Math.sin(P * t), Math.sin(Q * t)];
}

const positions = new Float32Array(U * V * 3);
let w = 0;
for (let i = 0; i < U; i++) {
  const t = (i / U) * Math.PI * 2;
  const c0 = curve(t);
  const c1 = curve(t + 0.002);
  let tx = c1[0] - c0[0], ty = c1[1] - c0[1], tz = c1[2] - c0[2];
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  // stable frame: cross tangent with world up, fall back to x axis
  let ux = -ty, uy = tx, uz = 0;
  let ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-6) { ux = 1; uy = 0; uz = 0; ul = 1; }
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
  for (let j = 0; j < V; j++) {
    const s = (j / V) * Math.PI * 2;
    const ripple = 1 + 0.09 * Math.sin(7 * t) * Math.sin(5 * s);
    const r = TUBE * ripple;
    positions[w++] = c0[0] + r * (Math.cos(s) * ux + Math.sin(s) * vx);
    positions[w++] = c0[1] + r * (Math.cos(s) * uy + Math.sin(s) * vy);
    positions[w++] = c0[2] + r * (Math.cos(s) * uz + Math.sin(s) * vz);
  }
}

const indices = new Uint32Array(U * V * 6);
let k = 0;
for (let i = 0; i < U; i++) {
  for (let j = 0; j < V; j++) {
    const a = i * V + j;
    const b = ((i + 1) % U) * V + j;
    const c = ((i + 1) % U) * V + ((j + 1) % V);
    const d = i * V + ((j + 1) % V);
    indices[k++] = a; indices[k++] = b; indices[k++] = d;
    indices[k++] = b; indices[k++] = c; indices[k++] = d;
  }
}

const idxBytes = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);
const posBytes = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
const pad = (n) => (4 - (n % 4)) % 4;
const buf = Buffer.concat([idxBytes, Buffer.alloc(pad(idxBytes.length)), posBytes]);

let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length; i += 3) {
  for (let d = 0; d < 3; d++) {
    min[d] = Math.min(min[d], positions[i + d]);
    max[d] = Math.max(max[d], positions[i + d]);
  }
}

const gltf = {
  asset: { version: "2.0", generator: "three-d mesh-lod-studio gen-sample.mjs" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: "torus-knot-ripple" }],
  meshes: [{
    name: "torus-knot-ripple",
    primitives: [{
      attributes: { POSITION: 0 },
      indices: 1,
      mode: 4,
      material: 0,
    }],
  }],
  materials: [{
    name: "matte",
    pbrMetallicRoughness: { baseColorFactor: [0.72, 0.78, 0.86, 1], metallicFactor: 0.1, roughnessFactor: 0.65 },
  }],
  buffers: [{
    byteLength: buf.length,
    uri: "data:application/octet-stream;base64," + buf.toString("base64"),
  }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: idxBytes.length, target: 34963 },
    { buffer: 0, byteOffset: idxBytes.length + pad(idxBytes.length), byteLength: posBytes.length, target: 34962 },
  ],
  accessors: [
    { bufferView: 1, componentType: 5126, count: U * V, type: "VEC3", min, max },
    { bufferView: 0, componentType: 5125, count: indices.length, type: "SCALAR", min: [0], max: [U * V - 1] },
  ],
};

mkdirSync(join(ROOT, "data"), { recursive: true });
const out = JSON.stringify(gltf);
writeFileSync(join(ROOT, "data", "mesh.gltf"), out);
console.log(`data/mesh.gltf  vertices=${U * V}  triangles=${U * V * 2}  bytes=${out.length}`);
