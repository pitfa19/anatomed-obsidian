import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

// Decode actual GLBs with the same loader/decoder and run the real tint helper.
// Compare all mesh transforms plus every restored part's world-space bounds.
const [repo, output, mode = 'assert'] = process.argv.slice(2);
if (!repo || !output) throw Error('Usage: node test/renderer-source-geometry.mjs REPO OUTPUT [observe]');
const load = file => import(pathToFileURL(path.join(repo, file)).href);
const THREE = await load('node_modules/three/build/three.module.js');
const { GLTFLoader } = await load('node_modules/three/examples/jsm/loaders/GLTFLoader.js');
const { MeshoptDecoder } = await load('node_modules/three/examples/jsm/libs/meshopt_decoder.module.js');
const { applyTint, findPartByName } = await load('widget/lib/three-helpers.ts');
globalThis.self = globalThis;
const catalog = JSON.parse(await fs.readFile(path.join(repo, 'assets/parts-catalog.json'), 'utf8'));
const decisions = JSON.parse(await fs.readFile(path.join(repo, 'assets/source-restoration-decisions.json'), 'utf8'));
const restored = decisions.rows.filter(r => r.decision.startsWith('restore-'));
assert.equal(restored.length, 123);
const result = { repo, generatedAt: new Date().toISOString(), restored: [], systems: [], unexpectedChanges: [] };
const bounds = object => {
  object.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(object);
  return [box.min.toArray(), box.max.toArray()];
};
for (const system of catalog.systems) {
  const bytes = await fs.readFile(path.join(repo, 'assets/glb', `${system.id}.glb`));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const scene = gltf.scene.clone(true);
  scene.updateMatrixWorld(true);
  const meshes = [];
  scene.traverse(mesh => { if (mesh.isMesh) meshes.push({ mesh, name: mesh.name, scale: mesh.scale.toArray(), matrix: mesh.matrixWorld.toArray(), bounds: bounds(mesh) }); });
  const targets = restored.filter(r => r.system === system.id).map(row => {
    const node = findPartByName(scene, row.current_id);
    assert.ok(node, `restored target exists: ${row.current_id}`);
    let triangles = 0;
    node.traverse(mesh => { if (mesh.isMesh) triangles += Math.floor((mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3); });
    const before = bounds(node);
    assert.ok(triangles > 0 && before.flat().every(Number.isFinite), `restored target has finite triangle geometry: ${row.current_id}`);
    return { row, node, before, triangles };
  });
  applyTint(scene, system.tint, system.id);
  scene.updateMatrixWorld(true);
  const changed = [];
  for (const prior of meshes) {
    const after = { scale: prior.mesh.scale.toArray(), matrix: prior.mesh.matrixWorld.toArray(), bounds: bounds(prior.mesh) };
    if (JSON.stringify([prior.scale, prior.matrix, prior.bounds]) !== JSON.stringify([after.scale, after.matrix, after.bounds])) changed.push({ name: prior.name, before: { scale: prior.scale, matrix: prior.matrix, bounds: prior.bounds }, after });
  }
  for (const target of targets) {
    const after = bounds(target.node);
    result.restored.push({ id: target.row.current_id, system: system.id, triangles: target.triangles, before: target.before, after, unchanged: JSON.stringify(target.before) === JSON.stringify(after) });
  }
  result.systems.push({ system: system.id, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), meshes: meshes.length, changed });
  if (system.id !== 'insertions') result.unexpectedChanges.push(...changed.map(row => ({ system: system.id, ...row })));
}
await fs.writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ repo, restored: result.restored.length, restoredChanged: result.restored.filter(r => !r.unchanged).length, changedBySystem: result.systems.map(r => [r.system, r.changed.length]), unexpected: result.unexpectedChanges.length }));
if (mode !== 'observe') {
  assert.equal(result.restored.length, 123);
  assert.equal(result.restored.filter(r => !r.unchanged).length, 0, 'restored real anatomy must not be distorted');
  assert.equal(result.unexpectedChanges.length, 0, 'only intentional insertion markers may be rescaled');
  assert.equal(result.systems.find(r => r.system === 'insertions').changed.length, 122, 'intentional insertion-marker behavior is preserved');
}
