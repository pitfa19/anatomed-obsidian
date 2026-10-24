import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

globalThis.self = globalThis;
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export const helper = name => /\.(i|j|g|s|t)$/.test(name) || /-lin|labels/.test(name);
export const sanitize = THREE.PropertyBinding.sanitizeNodeName;
export const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const key = p => `${p.system}\0${p.id}`;

/** Decode real buffers, including Meshopt. Bounds are accumulated from transformed
 * vertices, not accessor bounds or transformed boxes. This validates actual data. */
export async function loadGeometry(file) {
  const bytes = Buffer.isBuffer(file) ? file : await fs.readFile(file);
  const raw = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  gltf.scene.updateMatrixWorld(true);
  const nodes = [], byName = new Map(), byRaw = new Map(), meshChecks = new Map();
  const point = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  gltf.scene.traverse(obj => {
    const index = gltf.parser.associations.get(obj)?.nodes;
    const row = { obj, rawIndex: index ?? null, rawName: index === undefined ? null : raw.nodes[index]?.name };
    nodes.push(row);
    byName.set(obj.name, [...(byName.get(obj.name) ?? []), row]);
    if (row.rawName) byRaw.set(row.rawName, [...(byRaw.get(row.rawName) ?? []), row]);
    if (!obj.isMesh) return;
    const pos = obj.geometry.attributes.position, idx = obj.geometry.index;
    const box = new THREE.Box3();
    let invalid = !obj.matrixWorld.elements.every(Number.isFinite), positiveTriangles = 0, degenerateTriangles = 0;
    for (let i = 0; i < (pos?.count ?? 0); i++) {
      point.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      if (!point.toArray().every(Number.isFinite)) invalid = true;
      box.expandByPoint(point);
    }
    const normals = obj.geometry.attributes.normal;
    for (let i = 0; i < (normals?.count ?? 0); i++) {
      if (![normals.getX(i), normals.getY(i), normals.getZ(i)].every(Number.isFinite)) invalid = true;
    }
    const count = idx?.count ?? pos?.count ?? 0;
    for (let i = 0; i < count; i++) {
      const n = idx ? idx.getX(i) : i;
      if (!Number.isInteger(n) || n < 0 || n >= (pos?.count ?? 0)) invalid = true;
    }
    if (!invalid && pos) for (let i = 0; i + 2 < count; i += 3) {
      a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(obj.matrixWorld);
      b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(obj.matrixWorld);
      c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(obj.matrixWorld);
      const area2 = b.sub(a).cross(c.sub(a)).lengthSq();
      if (!Number.isFinite(area2)) invalid = true;
      else if (area2 > 0) positiveTriangles++;
      else degenerateTriangles++;
    }
    meshChecks.set(obj, { vertices: pos?.count ?? 0, triangles: Math.floor(count / 3), positiveTriangles,
      degenerateTriangles, invalid, box });
  });
  function describe(row) {
    const box = new THREE.Box3();
    let vertices = 0, triangles = 0, positiveTriangles = 0, invalid = false, meshes = 0;
    const rawIndices = [];
    row.obj.traverse(obj => {
      if (!obj.isMesh || helper(obj.name)) return;
      const g = meshChecks.get(obj);
      vertices += g.vertices; triangles += g.triangles; positiveTriangles += g.positiveTriangles;
      invalid ||= g.invalid; meshes++; box.union(g.box);
      const index = gltf.parser.associations.get(obj)?.nodes;
      if (index !== undefined) rawIndices.push(index);
    });
    const bounds = box.isEmpty() ? null : [box.min.toArray(), box.max.toArray()];
    const positive = !invalid && positiveTriangles > 0 && !!bounds && bounds.flat().every(Number.isFinite);
    return { vertices, triangles, positiveTriangles, invalid, meshes, bounds, positive, rawIndices };
  }
  return { sha256: sha256(bytes), raw, nodes, byName, byRaw, describe,
    lookup(id) { const rows = byName.get(sanitize(id)) ?? []; return rows.length === 1 ? rows[0] : null; },
    dispose() { gltf.scene.traverse(obj => { if (obj.isMesh) { obj.geometry.dispose(); for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) m.dispose(); } }); } };
}

/** Axis-aligned bounding box distance in metres, matching the historical pipeline.
 * This is an anatomical neighborhood heuristic, not surface-to-surface distance. */
export function boxDistance(a, b) {
  return Math.hypot(...[0, 1, 2].map(i => Math.max(0, a[0][i] - b[1][i], b[0][i] - a[1][i])));
}
export function buildNeighbors(parts, geometry, limit = 30) {
  const rows = parts.map((p, index) => ({ ...p, index, bounds: geometry.get(key(p)).bounds }));
  return Object.fromEntries(rows.map(p => [p.id, rows.filter(q => q.id !== p.id)
    .map(q => ({ id: q.id, system: q.system, dist: boxDistance(p.bounds, q.bounds), index: q.index }))
    .sort((a, b) => a.dist - b.dist || a.index - b.index).slice(0, limit)
    .map(({ index, ...q }) => ({ ...q, dist: Number(q.dist.toFixed(6)) }))]));
}
