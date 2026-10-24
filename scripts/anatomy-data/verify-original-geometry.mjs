import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadGeometry } from './geometry.mjs';
const [originalDir, repairedDir] = process.argv.slice(2);
assert(originalDir && repairedDir, 'Usage: node verify-original-geometry.mjs ORIGINAL_GLB_DIR REPAIRED_GLB_DIR');
function signature(obj) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(obj.matrixWorld.elements));
  const g = obj.geometry;
  for (const [name, attribute] of [...Object.entries(g.attributes), ['index', g.index]].filter(([, a]) => a).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([name, attribute.count, attribute.itemSize, attribute.normalized]));
    const values = new Float64Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++) for (let j = 0; j < attribute.itemSize; j++)
      values[i * attribute.itemSize + j] = attribute.getComponent(i, j);
    hash.update(Buffer.from(values.buffer));
  }
  return hash.digest('hex');
}
for (const system of ['muscles', 'organs']) {
  const original = await loadGeometry(path.join(originalDir, `${system}.glb`));
  const repaired = await loadGeometry(path.join(repairedDir, `${system}.glb`));
  let checked = 0;
  for (const row of original.nodes.filter(n => n.obj.isMesh)) {
    const matches = repaired.byName.get(row.obj.name) ?? [];
    assert.equal(matches.length, 1, row.obj.name);
    assert.equal(signature(row.obj), signature(matches[0].obj), `Original decoded mesh changed: ${row.obj.name}`);
    checked++;
  }
  console.log(JSON.stringify({ system, original_meshes_checked: checked, decoded_attributes_indices_and_world_matrices_unchanged: true }));
  original.dispose(); repaired.dispose();
}
