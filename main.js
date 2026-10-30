// main.js — rendering + interaction only. All geometry math comes from src/core.mjs.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  readGltfMesh, simplifyQEM, clusteringToTarget,
} from "./src/core.mjs";

const $ = (id) => document.getElementById(id);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog = new THREE.Fog(0x0d1117, 14, 30);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 100);
camera.position.set(7.5, 5.2, 8.5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$("app").appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.7;

scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x1b2430, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(6, 9, 7);
scene.add(key);
const rim = new THREE.DirectionalLight(0x4f8cff, 1.2);
rim.position.set(-7, -3, -6);
scene.add(rim);

const group = new THREE.Group();
scene.add(group);

const solidMat = new THREE.MeshStandardMaterial({
  color: 0x6ea8fe, metalness: 0.25, roughness: 0.42, flatShading: true,
});
const ghostMat = new THREE.MeshBasicMaterial({
  color: 0x2f4f6f, wireframe: true, transparent: true, opacity: 0.28,
});

let source = null;
let ghost = null;
let solid = null;
let mode = "qem";
let ratio = 0.06;
let timer = null;

function buildGeometry(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(mesh.positions), 3));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(mesh.indices), 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function frame(mesh) {
  const s = new THREE.Sphere();
  const g = buildGeometry(mesh);
  g.computeBoundingSphere();
  s.copy(g.boundingSphere);
  const dist = s.radius / Math.sin((camera.fov * Math.PI) / 360);
  controls.target.set(0, 0, 0);
  camera.position.setLength(dist * 1.05);
  camera.near = dist * 0.05;
  camera.far = dist * 6;
  camera.updateProjectionMatrix();
  return g;
}

function rebuild() {
  if (!source) return;
  const t0 = performance.now();
  let out;
  if (mode === "qem") {
    out = simplifyQEM(source, ratio);
  } else {
    out = clusteringToTarget(source, Math.max(8, Math.round(source.indices.length / 3 * ratio))).mesh;
  }
  const ms = performance.now() - t0;

  if (solid) { group.remove(solid); solid.geometry.dispose(); }
  const g = buildGeometry(out);
  if (!solid) {
    solid = new THREE.Mesh(g, solidMat);
  } else {
    solid.geometry = g;
  }
  group.add(solid);

  const tris = out.indices.length / 3;
  $("tris").textContent = tris.toLocaleString();
  $("red").textContent = (100 * (1 - tris / (source.indices.length / 3))).toFixed(1) + "%";
  $("ms").textContent = ms.toFixed(0) + " ms";
  $("ratio").textContent = Math.round(ratio * 100) + "%";
  renderer.render(scene, camera);
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rebuild, 40);
}

$("slider").addEventListener("input", (e) => {
  ratio = Number(e.target.value) / 100;
  schedule();
});
$("qem").addEventListener("click", () => {
  mode = "qem";
  $("qem").classList.add("on"); $("cluster").classList.remove("on");
  rebuild();
});
$("cluster").addEventListener("click", () => {
  mode = "cluster";
  $("cluster").classList.add("on"); $("qem").classList.remove("on");
  rebuild();
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

async function boot() {
  const gltf = await (await fetch("./data/mesh.gltf")).json();
  source = readGltfMesh(gltf);
  const g = frame(source);
  ghost = new THREE.Mesh(g, ghostMat);
  group.add(ghost);
  rebuild();
}

function loop() {
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
}
loop();

boot().catch((e) => {
  $("err").textContent = "failed to load data/mesh.gltf: " + e.message;
  console.error(e);
});
