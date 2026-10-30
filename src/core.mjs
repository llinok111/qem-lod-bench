// src/core.mjs
// Pure mesh-LOD core: quadric-error-metric (QEM) edge-collapse simplification,
// vertex-clustering baseline, deterministic surface sampling and symmetric
// Hausdorff error. No three.js, no DOM, no I/O — importable in plain node.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/* ------------------------------------------------------------------ */
/* glTF (embedded buffer) reader                                       */
/* ------------------------------------------------------------------ */

export function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Reads the first primitive of the first mesh. Supports an embedded
// base64 buffer, or a Uint8Array passed as `binary`.
export function readGltfMesh(gltf, binary) {
  const mesh = gltf.meshes[gltf.mesh ?? 0];
  if (!mesh) throw new Error("gltf: no mesh");
  const prim = mesh.primitives[0];
  const posAcc = gltf.accessors[prim.attributes.POSITION];
  let bytes = binary;
  if (!bytes) {
    const uri = gltf.buffers[0].uri || "";
    const comma = uri.indexOf(",");
    if (!uri.startsWith("data:") || comma < 0) {
      throw new Error("gltf: buffer is not an embedded data URI");
    }
    bytes = decodeBase64(uri.slice(comma + 1));
  }
  const readView = (acc, Ctor, comps) => {
    const bv = gltf.bufferViews[acc.bufferView];
    const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const n = acc.count * comps;
    if (off % Ctor.BYTES_PER_ELEMENT === 0) {
      return new Ctor(bytes.buffer, bytes.byteOffset + off, n);
    }
    const copy = new Ctor(n);
    new Uint8Array(copy.buffer).set(bytes.subarray(off, off + n * Ctor.BYTES_PER_ELEMENT));
    return copy;
  };
  const p = readView(posAcc, Float32Array, 3);
  const positions = new Float64Array(p.length);
  for (let i = 0; i < p.length; i++) positions[i] = p[i];
  let indices;
  if (prim.indices != null) {
    const ia = gltf.accessors[prim.indices];
    indices = Uint32Array.from(readView(ia, Uint32Array, 1));
  } else {
    indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  }
  return { positions, indices };
}

/* ------------------------------------------------------------------ */
/* stats                                                               */
/* ------------------------------------------------------------------ */

export function meshStats(mesh) {
  const pos = mesh.positions;
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  const dx = maxx - minx, dy = maxy - miny, dz = maxz - minz;
  return {
    vertices: pos.length / 3,
    triangles: mesh.indices.length / 3,
    bbox: { min: [minx, miny, minz], max: [maxx, maxy, maxz] },
    diagonal: Math.hypot(dx, dy, dz),
  };
}

/* ------------------------------------------------------------------ */
/* welding                                                             */
/* ------------------------------------------------------------------ */

export function weld(mesh, eps = 1e-9) {
  const pos = mesh.positions, idx = mesh.indices;
  const inv = 1 / eps;
  const map = new Map();
  const outPos = [];
  const remap = new Uint32Array(pos.length / 3);
  for (let v = 0; v < pos.length / 3; v++) {
    const x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2];
    const key = Math.round(x * inv) + "," + Math.round(y * inv) + "," + Math.round(z * inv);
    let nv = map.get(key);
    if (nv === undefined) {
      nv = outPos.length / 3;
      map.set(key, nv);
      outPos.push(x, y, z);
    }
    remap[v] = nv;
  }
  const outIdx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) outIdx[i] = remap[idx[i]];
  return {
    positions: Float64Array.from(outPos),
    indices: outIdx,
    merged: pos.length / 3 - outPos.length / 3,
  };
}

/* ------------------------------------------------------------------ */
/* QEM simplification                                                  */
/* ------------------------------------------------------------------ */

function faceNormal(pos, a, b, c, out) {
  const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
  const e1x = pos[3 * b] - ax, e1y = pos[3 * b + 1] - ay, e1z = pos[3 * b + 2] - az;
  const e2x = pos[3 * c] - ax, e2y = pos[3 * c + 1] - ay, e2z = pos[3 * c + 2] - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz);
  const area = len * 0.5;
  if (len > 1e-20) { nx /= len; ny /= len; nz /= len; }
  out[0] = nx; out[1] = ny; out[2] = nz; out[3] = area;
  return out;
}

function quadricCost(Q, o, x, y, z) {
  const a2 = Q[o], ab = Q[o + 1], ac = Q[o + 2], ad = Q[o + 3];
  const b2 = Q[o + 4], bc = Q[o + 5], bd = Q[o + 6];
  const c2 = Q[o + 7], cd = Q[o + 8], d2 = Q[o + 9];
  return a2 * x * x + 2 * ab * x * y + 2 * ac * x * z + 2 * ad * x +
    b2 * y * y + 2 * bc * y * z + 2 * bd * y +
    c2 * z * z + 2 * cd * z + d2;
}

class MinHeap {
  constructor() { this.k = []; this.c = []; }
  get size() { return this.k.length; }
  push(cost, key) {
    const k = this.k, c = this.c;
    let i = k.length;
    k.push(key); c.push(cost);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p] <= c[i]) break;
      const tk = k[p], tc = c[p];
      k[p] = k[i]; c[p] = c[i]; k[i] = tk; c[i] = tc;
      i = p;
    }
  }
  pop() {
    const k = this.k, c = this.c;
    const top = k[0];
    const lastK = k.pop(), lastC = c.pop();
    if (k.length) {
      k[0] = lastK; c[0] = lastC;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && c[l] < c[m]) m = l;
        if (r < k.length && c[r] < c[m]) m = r;
        if (m === i) break;
        const tk = k[m], tc = c[m];
        k[m] = k[i]; c[m] = c[i]; k[i] = tk; c[i] = tc;
        i = m;
      }
    }
    return top;
  }
}

// Edge-collapse QEM. Collapses are half-edge: the surviving vertex is moved to
// the cheaper of the two endpoints or their midpoint (all three are scored).
export function simplifyQEM(mesh, targetRatio, opts = {}) {
  const ratio = clamp(targetRatio, 0.02, 1);
  const src = opts.weld === false ? mesh : weld(mesh, opts.eps ?? 1e-9);
  const pos = Float64Array.from(src.positions);
  const faces = Int32Array.from(src.indices);
  const nV = pos.length / 3;
  const nF = faces.length / 3;
  const aliveV = new Uint8Array(nV).fill(1);
  const aliveF = new Uint8Array(nF).fill(1);
  const vf = new Array(nV);
  for (let v = 0; v < nV; v++) vf[v] = new Set();
  for (let f = 0; f < nF; f++) {
    vf[faces[3 * f]].add(f);
    vf[faces[3 * f + 1]].add(f);
    vf[faces[3 * f + 2]].add(f);
  }

  const Q = new Float64Array(nV * 10);
  const fn = new Float64Array(nF * 3);
  const tmp = new Float64Array(4);
  for (let f = 0; f < nF; f++) {
    const a = faces[3 * f], b = faces[3 * f + 1], c = faces[3 * f + 2];
    faceNormal(pos, a, b, c, tmp);
    const nx = tmp[0], ny = tmp[1], nz = tmp[2], w = tmp[3];
    fn[3 * f] = nx; fn[3 * f + 1] = ny; fn[3 * f + 2] = nz;
    const d = -(nx * pos[3 * a] + ny * pos[3 * a + 1] + nz * pos[3 * a + 2]);
    const q = [nx * nx, nx * ny, nx * nz, nx * d,
      ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d];
    for (const v of [a, b, c]) {
      const o = v * 10;
      for (let i = 0; i < 10; i++) Q[o + i] += w * q[i];
    }
  }

  const edges = new Map();
  const heap = new MinHeap();
  const stampOf = new Map();

  const edgeKey = (a, b) => (a < b ? a * nV + b : b * nV + a);

  function pushEdge(a, b) {
    if (a === b) return;
    const key = edgeKey(a, b);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const qo = lo * 10, qp = hi * 10;
    const ax = pos[3 * lo], ay = pos[3 * lo + 1], az = pos[3 * lo + 2];
    const bx = pos[3 * hi], by = pos[3 * hi + 1], bz = pos[3 * hi + 2];
    const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
    const ca = quadricCost(Q, qo, ax, ay, az) + quadricCost(Q, qp, ax, ay, az);
    const cb = quadricCost(Q, qo, bx, by, bz) + quadricCost(Q, qp, bx, by, bz);
    const cm = quadricCost(Q, qo, mx, my, mz) + quadricCost(Q, qp, mx, my, mz);
    let cost = ca, x = ax, y = ay, z = az;
    if (cb < cost) { cost = cb; x = bx; y = by; z = bz; }
    if (cm < cost) { cost = cm; x = mx; y = my; z = mz; }
    const stamp = (stampOf.get(key) || 0) + 1;
    stampOf.set(key, stamp);
    edges.set(key, { a: lo, b: hi, cost, x, y, z, stamp });
    heap.push(cost, key);
  }

  for (let f = 0; f < nF; f++) {
    const a = faces[3 * f], b = faces[3 * f + 1], c = faces[3 * f + 2];
    pushEdge(a, b); pushEdge(b, c); pushEdge(c, a);
  }

  let tris = nF;
  const target = Math.max(4, Math.round(nF * ratio));
  let collapses = 0;
  const maxCollapses = opts.maxCollapses ?? nF * 2;

  function tryCollapse(ed) {
    const a = ed.a, b = ed.b;
    if (!aliveV[a] || !aliveV[b]) return 0;
    const nx = ed.x, ny = ed.y, nz = ed.z;
    const affected = new Set();
    for (const f of vf[a]) if (aliveF[f]) affected.add(f);
    for (const f of vf[b]) if (aliveF[f]) affected.add(f);

    // Pre-check: no triangle may flip or become degenerate-with-area.
    for (const f of affected) {
      const i0 = faces[3 * f], i1 = faces[3 * f + 1], i2 = faces[3 * f + 2];
      const a0 = i0 === b ? a : i0, a1 = i1 === b ? a : i1, a2 = i2 === b ? a : i2;
      if (a0 === a1 || a1 === a2 || a0 === a2) continue;
      const save0 = pos[3 * a], save1 = pos[3 * a + 1], save2 = pos[3 * a + 2];
      pos[3 * a] = nx; pos[3 * a + 1] = ny; pos[3 * a + 2] = nz;
      faceNormal(pos, a0, a1, a2, tmp);
      pos[3 * a] = save0; pos[3 * a + 1] = save1; pos[3 * a + 2] = save2;
      const dot = tmp[0] * fn[3 * f] + tmp[1] * fn[3 * f + 1] + tmp[2] * fn[3 * f + 2];
      if (dot < 0.25) return 0;
    }

    // Apply.
    pos[3 * a] = nx; pos[3 * a + 1] = ny; pos[3 * a + 2] = nz;
    const qa = a * 10, qb = b * 10;
    for (let i = 0; i < 10; i++) Q[qa + i] += Q[qb + i];
    let removed = 0;
    for (const f of [...vf[b]]) {
      if (!aliveF[f]) continue;
      const i0 = faces[3 * f], i1 = faces[3 * f + 1], i2 = faces[3 * f + 2];
      const n0 = i0 === b ? a : i0, n1 = i1 === b ? a : i1, n2 = i2 === b ? a : i2;
      vf[b].delete(f);
      if (n0 === n1 || n1 === n2 || n0 === n2) {
        aliveF[f] = 0;
        removed++;
        for (const v of new Set([i0, i1, i2])) vf[v].delete(f);
        continue;
      }
      faces[3 * f] = n0; faces[3 * f + 1] = n1; faces[3 * f + 2] = n2;
      vf[a].add(f);
      faceNormal(pos, n0, n1, n2, tmp);
      fn[3 * f] = tmp[0]; fn[3 * f + 1] = tmp[1]; fn[3 * f + 2] = tmp[2];
    }
    aliveV[b] = 0;
    vf[b].clear();
    for (const f of vf[a]) {
      if (!aliveF[f]) continue;
      const i0 = faces[3 * f], i1 = faces[3 * f + 1], i2 = faces[3 * f + 2];
      if (i0 === b || i1 === b || i2 === b) continue;
      faceNormal(pos, i0, i1, i2, tmp);
      fn[3 * f] = tmp[0]; fn[3 * f + 1] = tmp[1]; fn[3 * f + 2] = tmp[2];
    }
    // Refresh all edges incident to the surviving vertex.
    const nb = new Set();
    for (const f of vf[a]) {
      if (!aliveF[f]) continue;
      nb.add(faces[3 * f]); nb.add(faces[3 * f + 1]); nb.add(faces[3 * f + 2]);
    }
    nb.delete(a);
    for (const n of nb) if (aliveV[n]) pushEdge(a, n);
    return removed;
  }

  while (tris > target && heap.size && collapses < maxCollapses) {
    let ed = null;
    while (heap.size) {
      const key = heap.pop();
      const e = edges.get(key);
      if (e && e.stamp === stampOf.get(key) && aliveV[e.a] && aliveV[e.b]) { ed = e; break; }
    }
    if (!ed) break;
    const removed = tryCollapse(ed);
    if (removed > 0) {
      tris -= removed;
      collapses++;
      edges.delete(edgeKey(ed.a, ed.b));
    } else {
      edges.delete(edgeKey(ed.a, ed.b));
    }
  }

  // Compact live faces / vertices.
  const usedV = new Uint8Array(nV);
  for (let f = 0; f < nF; f++) {
    if (!aliveF[f]) continue;
    usedV[faces[3 * f]] = 1; usedV[faces[3 * f + 1]] = 1; usedV[faces[3 * f + 2]] = 1;
  }
  const remap = new Int32Array(nV).fill(-1);
  const outPos = [];
  for (let v = 0; v < nV; v++) {
    if (!usedV[v]) continue;
    remap[v] = outPos.length / 3;
    outPos.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
  }
  const outIdx = [];
  for (let f = 0; f < nF; f++) {
    if (!aliveF[f]) continue;
    outIdx.push(remap[faces[3 * f]], remap[faces[3 * f + 1]], remap[faces[3 * f + 2]]);
  }
  return {
    positions: Float64Array.from(outPos),
    indices: Uint32Array.from(outIdx),
    collapses,
    triangles: outIdx.length / 3,
    vertices: outPos.length / 3,
  };
}

/* ------------------------------------------------------------------ */
/* baseline: vertex clustering                                         */
/* ------------------------------------------------------------------ */

export function simplifyVertexClustering(mesh, resolution) {
  const src = weld(mesh, 1e-9);
  const st = meshStats(src);
  const { min, max } = st.bbox;
  const cell = Math.max(st.diagonal, 1e-9) / Math.max(2, resolution);
  const map = new Map();
  const sum = [];
  const cnt = [];
  const remap = new Int32Array(src.positions.length / 3);
  for (let v = 0; v < src.positions.length / 3; v++) {
    const x = src.positions[3 * v], y = src.positions[3 * v + 1], z = src.positions[3 * v + 2];
    const ix = Math.floor((x - min[0]) / cell);
    const iy = Math.floor((y - min[1]) / cell);
    const iz = Math.floor((z - min[2]) / cell);
    const key = ix + "," + iy + "," + iz;
    let c = map.get(key);
    if (c === undefined) {
      c = sum.length / 3;
      map.set(key, c);
      sum.push(0, 0, 0);
      cnt.push(0);
    }
    remap[v] = c;
    sum[3 * c] += x; sum[3 * c + 1] += y; sum[3 * c + 2] += z;
    cnt[c]++;
  }
  const positions = new Float64Array(sum.length);
  for (let c = 0; c < cnt.length; c++) {
    positions[3 * c] = sum[3 * c] / cnt[c];
    positions[3 * c + 1] = sum[3 * c + 1] / cnt[c];
    positions[3 * c + 2] = sum[3 * c + 2] / cnt[c];
  }
  const out = [];
  for (let f = 0; f < src.indices.length; f += 3) {
    const a = remap[src.indices[f]], b = remap[src.indices[f + 1]], c = remap[src.indices[f + 2]];
    if (a === b || b === c || a === c) continue;
    out.push(a, b, c);
  }
  return {
    positions,
    indices: Uint32Array.from(out),
    triangles: out.length / 3,
    vertices: cnt.length,
  };
}

// Pick the clustering resolution whose triangle count is closest to `target`.
export function clusteringToTarget(mesh, target) {
  let best = null;
  for (let r = 4; r <= 256; r = Math.ceil(r * 1.25)) {
    const m = simplifyVertexClustering(mesh, r);
    const err = Math.abs(m.triangles - target);
    if (!best || err < best.err) best = { mesh: m, err, resolution: r };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* deterministic sampling + distance                                   */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleSurface(mesh, count, seed = 1) {
  const pos = mesh.positions, idx = mesh.indices;
  const nF = idx.length / 3;
  const cum = new Float64Array(nF);
  let total = 0;
  for (let f = 0; f < nF; f++) {
    const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2];
    const e1x = pos[3 * b] - pos[3 * a], e1y = pos[3 * b + 1] - pos[3 * a + 1], e1z = pos[3 * b + 2] - pos[3 * a + 2];
    const e2x = pos[3 * c] - pos[3 * a], e2y = pos[3 * c + 1] - pos[3 * a + 1], e2z = pos[3 * c + 2] - pos[3 * a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    total += 0.5 * Math.hypot(nx, ny, nz);
    cum[f] = total;
  }
  const rng = mulberry32(seed);
  const out = new Float64Array(count * 3);
  for (let s = 0; s < count; s++) {
    const r = rng() * total;
    let lo = 0, hi = nF - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1; else hi = mid;
    }
    const f = lo;
    const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2];
    const r1 = Math.sqrt(rng()), r2 = rng();
    const w0 = 1 - r1, w1 = r1 * (1 - r2), w2 = r1 * r2;
    out[3 * s] = w0 * pos[3 * a] + w1 * pos[3 * b] + w2 * pos[3 * c];
    out[3 * s + 1] = w0 * pos[3 * a + 1] + w1 * pos[3 * b + 1] + w2 * pos[3 * c + 1];
    out[3 * s + 2] = w0 * pos[3 * a + 2] + w1 * pos[3 * b + 2] + w2 * pos[3 * c + 2];
  }
  return out;
}

function pointTriDistSq(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = apx - v * abx, qy = apy - v * aby, qz = apz - v * abz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = apx - w * acx, qy = apy - w * acy, qz = apz - w * acz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bpx - w * (cx - bx), qy = bpy - w * (cy - by), qz = bpz - w * (cz - bz);
    return qx * qx + qy * qy + qz * qz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const qx = apx - (v * abx + w * acx);
  const qy = apy - (v * aby + w * acy);
  const qz = apz - (v * abz + w * acz);
  return qx * qx + qy * qy + qz * qz;
}

export function nearestDistance(px, py, pz, mesh) {
  const pos = mesh.positions, idx = mesh.indices;
  let best = Infinity;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f], b = idx[f + 1], c = idx[f + 2];
    const d = pointTriDistSq(px, py, pz,
      pos[3 * a], pos[3 * a + 1], pos[3 * a + 2],
      pos[3 * b], pos[3 * b + 1], pos[3 * b + 2],
      pos[3 * c], pos[3 * c + 1], pos[3 * c + 2]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = clamp(Math.floor((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[i];
}

// Symmetric sampled Hausdorff: max over both directions, mean over both.
export function hausdorff(meshA, meshB, samples = 800, seed = 7) {
  const st = meshStats(meshA);
  const pa = sampleSurface(meshA, samples, seed);
  const pb = sampleSurface(meshB, samples, seed + 1);
  const d = [];
  for (let i = 0; i < samples; i++) {
    d.push(nearestDistance(pa[3 * i], pa[3 * i + 1], pa[3 * i + 2], meshB));
  }
  for (let i = 0; i < samples; i++) {
    d.push(nearestDistance(pb[3 * i], pb[3 * i + 1], pb[3 * i + 2], meshA));
  }
  const sorted = d.slice().sort((x, y) => x - y);
  let sum = 0;
  for (const x of d) sum += x;
  const diag = st.diagonal || 1;
  const res = {
    samples: d.length,
    mean: sum / d.length,
    max: sorted[sorted.length - 1],
    p95: pct(sorted, 0.95),
  };
  res.meanPct = (100 * res.mean) / diag;
  res.maxPct = (100 * res.max) / diag;
  res.p95Pct = (100 * res.p95) / diag;
  return res;
}
