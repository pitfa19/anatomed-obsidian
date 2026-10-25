// Standalone acceptance for the v3 dataset. Recomputes everything from decoded GLBs.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadGeometry, helper, key, sha256, buildNeighbors } from './geometry.mjs';
import { verifyV3 } from './apply-v3-edits.mjs';
import { verifyPreservedGeometry } from './append-source-additions.mjs';

const [assetsDir, glbDir = assetsDir && path.join(assetsDir, 'glb')] = process.argv.slice(2);
assert(assetsDir, 'Usage: node validate-v3.mjs ASSETS_DIR [GLB_DIR]');
const read = async name => JSON.parse(await fs.readFile(path.join(assetsDir, name), 'utf8'));
const catalog = await read('parts-catalog.json'), neighbors = await read('parts-neighbors.json');
const prov = await read('anatomy-provenance.json'), decisionsBytes = await fs.readFile(path.join(assetsDir, 'v3-decisions.json'));
const decisions = JSON.parse(decisionsBytes);
assert.equal(sha256(decisionsBytes), prov.v3.decisions_sha256);
assert.equal(sha256(await fs.readFile(path.join(assetsDir, 'parts-catalog.json'))), prov.checks.catalog_sha256);
assert.equal(sha256(await fs.readFile(path.join(assetsDir, 'parts-neighbors.json'))), prov.checks.neighbors_sha256);
assert.equal(catalog.systems.length, 9);
assert.equal(catalog.parts.length, 3911);
assert.equal(new Set(catalog.parts.map(p => p.id)).size, catalog.parts.length);
assert.equal(prov.source_decisions.length, 7184);
assert.equal(prov.source_decisions.filter(s => s.decision === 'included-v3-reviewed-source-surface').length, 19);
const valid = new Set(catalog.parts.map(key)), geometry = new Map(), out = [];
for (const system of catalog.systems) {
  const bytes = await fs.readFile(path.join(glbDir, `${system.id}.glb`)), model = await loadGeometry(bytes);
  const file = prov.files.find(f => f.system === system.id);
  assert.equal(model.sha256, file.sha256);
  assert(system.glb.includes(model.sha256.slice(0, 8)));
  const edit = prov.v3.edits.systems.find(s => s.system === system.id);
  if (edit) {
    verifyV3(bytes, edit);
    // The 0.1.8 additive guarantees (muscles/organs prefixes over the 0.1.7 originals) must still hold underneath.
    const additive = prov.source_additions.systems.find(s => s.system === system.id);
    if (additive) assert.equal(edit.base_sha256, additive.merged_sha256);
  } else if (file.original_sha256 && !prov.source_additions.systems.some(s => s.system === system.id)) assert.equal(model.sha256, file.original_sha256);
  else if (prov.source_additions.systems.some(s => s.system === system.id)) verifyPreservedGeometry(bytes, prov.source_additions.systems.find(s => s.system === system.id));
  const parts = catalog.parts.filter(p => p.system === system.id);
  assert.equal(parts.length, file.catalog_parts);
  for (const p of parts) {
    assert(!helper(p.id));
    const t = model.lookup(p.id); assert(t, `missing or ambiguous ${p.id}`);
    const g = model.describe(t); assert(g.positive && !g.invalid && g.positiveTriangles > 0, `invalid ${p.id}`);
    geometry.set(key(p), g);
  }
  out.push({ system: system.id, parts: parts.length, sha256: model.sha256.slice(0, 12) });
  model.dispose();
}
// Global laterality audit: no side-labelled part may sit clearly on the opposite side.
const wrong = [];
for (const p of catalog.parts) {
  const s = p.id.match(/\.([lr])$/)?.[1]; if (!s) continue;
  const b = geometry.get(key(p)).bounds, cx = (b[0][0] + b[1][0]) / 2, half = (b[1][0] - b[0][0]) / 2;
  if (Math.abs(cx) < Math.max(0.01, half * 0.5)) continue;
  if (s === 'l' ? cx < 0 : cx > 0) wrong.push(`${p.id} x=${(cx * 1000).toFixed(1)}mm`);
}
assert.deepEqual(wrong, [], `wrong-side parts: ${wrong.join(', ')}`);
for (const a of decisions.additions) assert(valid.has(key({ system: a.system, id: a.current_id })), a.current_id);
for (const o of prov.v3.edits.systems.flatMap(s => s.objects)) {
  const actual = geometry.get(key({ system: o.system, id: o.current_id })).bounds, { min, max } = o.source_world_bounds;
  const expected = [[min[0], min[2], -max[1]], [max[0], max[2], -min[1]]];
  assert(Math.max(...actual.flat().map((v, i) => Math.abs(v - expected.flat()[i]))) < 0.00001, o.current_id);
}
for (const row of prov.source_decisions) for (const t of row.current_targets) assert(valid.has(key(t)), `invalid source target ${row.source_id} -> ${t.id}`);
assert.deepEqual(neighbors, buildNeighbors(catalog.parts, geometry));
for (const [id, rows] of Object.entries(neighbors)) {
  assert.equal(rows.length, 30);
  for (const n of rows) assert(n.id !== id && valid.has(key(n)) && Number.isFinite(n.dist) && n.dist >= 0);
}
console.log(JSON.stringify({ passed: true, catalog_rows: catalog.parts.length, wrong_side: 0, v3_sources: 19,
  neighbor_edges: Object.values(neighbors).reduce((n, a) => n + a.length, 0), systems: out }, null, 2));
