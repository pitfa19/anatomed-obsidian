import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadGeometry, helper, key, sha256, buildNeighbors } from './geometry.mjs';
import { verifyPreservedGeometry } from './append-source-additions.mjs';

const [assetsDir, glbDir = assetsDir && path.join(assetsDir, 'glb')] = process.argv.slice(2);
assert(assetsDir, 'Usage: node validate.mjs ASSETS_DIR [GLB_DIR]');
const read = async name => JSON.parse(await fs.readFile(path.join(assetsDir, name), 'utf8'));
const catalog = await read('parts-catalog.json'), neighbors = await read('parts-neighbors.json');
const provenance = await read('anatomy-provenance.json');
const restoration = await read('source-restoration-decisions.json');
assert.equal(sha256(await fs.readFile(path.join(assetsDir, 'source-restoration-decisions.json'))), provenance.source_restoration_decisions_sha256);
assert.equal(restoration.rows.length, 125);
assert.equal(restoration.rows.filter(r => r.decision.startsWith('restore-')).length, 123);
assert.equal(provenance.source_additions.systems.flatMap(s => s.objects).length, 123);
assert.equal(catalog.systems.length, 9);
assert.equal(new Set(catalog.parts.map(p => p.id)).size, catalog.parts.length);
assert.equal(provenance.source_decisions.length, 7184);
assert.equal(new Set(provenance.source_decisions.map(o => o.source_id)).size, 7184);
assert.equal(provenance.catalog_decisions.length, 3540);
assert.equal(new Set(provenance.catalog_decisions.map(o => key(o.original))).size, 3540);
const baseline = JSON.parse(await fs.readFile(new URL('./baseline-catalog.json', import.meta.url)));
assert.deepEqual(provenance.catalog_decisions.map(o => o.original), baseline.parts);
assert.equal(sha256(await fs.readFile(path.join(assetsDir, 'parts-catalog.json'))), provenance.checks.catalog_sha256);
assert.equal(sha256(await fs.readFile(path.join(assetsDir, 'parts-neighbors.json'))), provenance.checks.neighbors_sha256);
const valid = new Set(catalog.parts.map(key)), geometry = new Map(), systems = [];
for (const system of catalog.systems) {
  const model = await loadGeometry(path.join(glbDir, `${system.id}.glb`));
  const file = provenance.files.find(f => f.system === system.id);
  assert.equal(model.sha256, file.sha256);
  const addition = provenance.source_additions.systems.find(s => s.system === system.id);
  if (addition) {
    assert.equal(addition.original_sha256, file.original_sha256);
    verifyPreservedGeometry(await fs.readFile(path.join(glbDir, `${system.id}.glb`)), addition);
  } else if (file.original_sha256) assert.equal(model.sha256, file.original_sha256);
  assert(system.glb.includes(model.sha256.slice(0, 8)));
  const parts = catalog.parts.filter(p => p.system === system.id);
  assert.equal(parts.length, file.catalog_parts);
  for (const p of parts) {
    assert(!helper(p.id), `Selectable helper ${p.id}`);
    const target = model.lookup(p.id);
    assert(target, `Missing or ambiguous ${p.id}`);
    const g = model.describe(target);
    assert(g.positive && !g.invalid && g.positiveTriangles > 0, `Nonpositive/nonfinite target ${p.id}`);
    geometry.set(key(p), g);
  }
  if (['nerves', 'vessels', 'lymphoid'].includes(system.id)) for (const row of model.nodes) {
    if (row.rawName && row.obj.isMesh && !helper(row.rawName) && model.describe(row).positive)
      assert(valid.has(key({ system: system.id, id: row.rawName })), `Uncatalogued converted surface ${row.rawName}`);
  }
  systems.push({ system: system.id, parts: parts.length, sha256: model.sha256 });
  model.dispose();
  console.log(`${system.id}: ${parts.length} finite positive targets`);
}
assert.equal(catalog.parts.filter(p => p.system === 'lymphoid').length, 160);
for (const id of ['Spleen', 'Left lobe of thymus', 'Right lobe of thymus']) {
  assert(valid.has(key({ system: 'organs', id })));
  assert(!valid.has(key({ system: 'lymphoid', id })));
}
for (const row of provenance.source_decisions) for (const target of row.current_targets)
  assert(valid.has(key(target)), `Invalid source target ${row.source_id}`);
for (const row of provenance.catalog_decisions) for (const target of row.targets)
  assert(valid.has(key(target)), `Invalid old catalog target ${row.original.id}`);
for (const record of [...provenance.lymphoid_export.exported, ...provenance.source_additions.systems.flatMap(s => s.objects)]) {
  const actual = geometry.get(key({ system: record.system, id: record.current_id })).bounds;
  const { min, max } = record.source_world_bounds;
  const expected = [[min[0], min[2], -max[1]], [max[0], max[2], -min[1]]];
  assert(Math.max(...actual.flat().map((v, i) => Math.abs(v - expected.flat()[i]))) < 0.00001, record.current_id);
}
for (const review of restoration.rows) {
  const source = provenance.source_decisions.find(s => s.source_id === review.source_id);
  assert.equal(source.source_review_decision, review.decision);
  if (review.decision.startsWith('restore-') || review.decision.startsWith('covered-'))
    assert(valid.has(key({ system: review.system, id: review.current_id })));
  if (review.source_id === 'Pleura') {
    assert(review.decision.startsWith('unresolved-'));
    assert(!catalog.parts.some(p => p.id === 'Pleura'));
  }
}
assert.deepEqual(neighbors, buildNeighbors(catalog.parts, geometry));
for (const [id, rows] of Object.entries(neighbors)) {
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  for (const n of rows) assert(n.id !== id && valid.has(key(n)) && Number.isFinite(n.dist) && n.dist >= 0);
}
console.log(JSON.stringify({ passed: true, catalog_rows: catalog.parts.length, source_decisions: 7184,
  baseline_decisions: 3540, original_glbs_byte_identical: 6, original_geometry_preserved_in_additive_glbs: 2,
  reviewed_source_restorations: 123, neighbor_edges: Object.values(neighbors).reduce((n, a) => n + a.length, 0), systems }, null, 2));
