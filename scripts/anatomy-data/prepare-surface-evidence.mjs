import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadGeometry, helper } from './geometry.mjs';
const [glbDir, outputDir] = process.argv.slice(2);
assert(glbDir && outputDir, 'Usage: node prepare-surface-evidence.mjs GLB_DIR OUTPUT_DIR');
await fs.mkdir(outputDir, { recursive: true });
for (const system of ['muscles', 'organs']) {
  const model = await loadGeometry(path.join(glbDir, `${system}.glb`));
  const chunks = [], ranges = [];
  let triangleStart = 0;
  const v = new THREE.Vector3();
  for (const row of model.nodes) {
    const obj = row.obj;
    if (!obj.isMesh || helper(row.rawName ?? obj.name)) continue;
    const pos = obj.geometry.attributes.position, idx = obj.geometry.index;
    const count = idx?.count ?? pos?.count ?? 0;
    if (!count) continue;
    const points = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(obj.matrixWorld);
      points.set(v.toArray(), i * 3);
    }
    chunks.push(Buffer.from(points.buffer));
    ranges.push({ name: row.rawName ?? obj.name, node_index: row.rawIndex, triangle_start: triangleStart, triangles: count / 3 });
    triangleStart += count / 3;
  }
  await fs.writeFile(path.join(outputDir, `${system}-triangles.bin`), Buffer.concat(chunks));
  await fs.writeFile(path.join(outputDir, `${system}-triangles.json`), JSON.stringify({ system, sha256: model.sha256,
    format: 'Little-endian float32, 9 world-Y-up position components per triangle, all nonhelper decoded meshes, no recenter.', triangles: triangleStart, ranges }, null, 2) + '\n');
  model.dispose(); console.log(system, triangleStart);
}
