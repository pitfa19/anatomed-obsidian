// Layer the reviewed 0.1.9 (v3) changes on top of the committed 0.1.8 catalog/provenance.
// The 0.1.8 pipeline (generate.mjs) stays reproducible as-is; this step only appends.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadGeometry, helper, key, sha256, buildNeighbors, compareText } from './geometry.mjs';
import { verifyV3 } from './apply-v3-edits.mjs';

const [baseAssetsDir, glbDir, outputDir, decisionsPath] = process.argv.slice(2);
assert(baseAssetsDir && glbDir && outputDir && decisionsPath, 'Usage: node generate-v3.mjs BASE_0.1.8_ASSETS_DIR V3_GLB_DIR OUTPUT_ASSETS_DIR V3_DECISIONS_JSON');
const read = async f => JSON.parse(await fs.readFile(f, 'utf8'));
const catalog0 = await read(path.join(baseAssetsDir, 'parts-catalog.json'));
const prov0 = await read(path.join(baseAssetsDir, 'anatomy-provenance.json'));
const restorationBytes = await fs.readFile(path.join(baseAssetsDir, 'source-restoration-decisions.json'));
const decisionsBytes = await fs.readFile(decisionsPath), decisions = JSON.parse(decisionsBytes);
const edits = await read(path.join(glbDir, 'v3-edits-merged.json'));
assert.equal(edits.decisions_sha256, sha256(decisionsBytes));
assert.equal(decisions.source_sha256, prov0.source_blend_sha256);
assert.equal(prov0.checks.catalog_rows, 3894);
assert.equal(sha256(await fs.readFile(path.join(baseAssetsDir, 'parts-catalog.json'))), prov0.checks.catalog_sha256);

const existing = new Set(catalog0.parts.map(p => p.id));
const newRows = decisions.additions.filter(a => !a.replaces_wrong_side_node);
for (const a of newRows) assert(!existing.has(a.current_id), `new ID collides: ${a.current_id}`);
for (const a of decisions.additions.filter(a => a.replaces_wrong_side_node)) assert(existing.has(a.current_id));
const side = id => id.match(/\.([lr])$/)?.[1];
const parts = [];
for (const system of catalog0.systems) {
  parts.push(...catalog0.parts.filter(p => p.system === system.id));
  parts.push(...newRows.filter(a => a.system === system.id).sort((x, y) => compareText(x.current_id, y.current_id))
    .map(a => ({ id: a.current_id, system: system.id, name_en: a.current_id.replace(/\.([lr])$/, '').trim(), name_lat: '',
      ...(side(a.current_id) ? { side: side(a.current_id) } : {}) })));
}
assert.equal(parts.length, catalog0.parts.length + newRows.length);
assert.equal(new Set(parts.map(p => p.id)).size, parts.length);

const systems = structuredClone(catalog0.systems), files = structuredClone(prov0.files), geometry = new Map();
const nodeIndex = new Map();
for (const system of systems) {
  const file = path.join(glbDir, `${system.id}.glb`);
  const bytes = await fs.readFile(file), model = await loadGeometry(bytes);
  const fileRow = files.find(f => f.system === system.id);
  const edit = edits.systems.find(s => s.system === system.id);
  if (edit) { assert.equal(edit.base_sha256, fileRow.sha256, `${system.id} v3 base is not the 0.1.8 file`); verifyV3(bytes, edit); }
  else assert.equal(model.sha256, fileRow.sha256, `${system.id} changed without a recorded v3 edit`);
  system.glb = `/models/glb/${system.id}.glb?v=${model.sha256.slice(0, 8)}`;
  const own = parts.filter(p => p.system === system.id);
  for (const p of own) {
    const row = model.lookup(p.id);
    assert(row, `missing or ambiguous decoded target ${p.id}`);
    const g = model.describe(row);
    assert(g.positive && !g.invalid && !helper(p.id), `invalid target ${p.id}`);
    geometry.set(key(p), g); nodeIndex.set(key(p), row.rawIndex);
  }
  if (edit) Object.assign(fileRow, { v018_sha256: fileRow.sha256, sha256: model.sha256, catalog_parts: own.length,
    v3: { renamed_nodes: edit.renames.length, detached_nodes: edit.detached.length, appended_nodes: edit.appended?.added_nodes ?? 0 } });
  else assert.equal(fileRow.catalog_parts, own.length);
  model.dispose();
  console.log(`JCODE_PROGRESS ${JSON.stringify({ current: systems.indexOf(system) + 1, total: systems.length, message: `${system.id}: ${own.length}` })}`);
}

// Source-coordinate check for every appended object (Blender Z-up -> glTF Y-up).
let maxBoundsError = 0;
for (const o of edits.systems.flatMap(s => s.objects)) {
  const actual = geometry.get(key({ system: o.system, id: o.current_id })).bounds, { min, max } = o.source_world_bounds;
  const expected = [[min[0], min[2], -max[1]], [max[0], max[2], -min[1]]];
  const error = Math.max(...actual.flat().map((v, i) => Math.abs(v - expected.flat()[i])));
  maxBoundsError = Math.max(maxBoundsError, error);
  assert(error < 0.00001, `coordinate mismatch ${o.current_id}: ${error} m`);
}
// Laterality: every corrected or added side-specific target must sit on its labelled side (left = +x).
const lateral = [...decisions.additions.map(a => ({ system: a.system, id: a.current_id })),
  ...decisions.renames.flatMap(r => r.swap.map(id => ({ system: r.system, id })))];
for (const t of lateral) {
  const s = side(t.id); if (!s) continue;
  const b = geometry.get(key(t)).bounds, cx = (b[0][0] + b[1][0]) / 2;
  assert(s === 'l' ? cx > 0 : cx < 0, `${t.id} centre x ${cx} is on the wrong side`);
}

const v3BySource = new Map(decisions.additions.map(a => [a.source_id, a]));
const swapped = new Map(decisions.renames.flatMap(r => [[r.swap[0], r.swap[1]], [r.swap[1], r.swap[0]]].map(([a, b]) => [`${r.system}\0${a}`, b])));
const sourceDecisions = prov0.source_decisions.map(s => {
  const a = v3BySource.get(s.source_id);
  if (a) return { ...s, decision: 'included-v3-reviewed-source-surface', previous_decision: s.decision,
    current_targets: [{ system: a.system, id: a.current_id, node_index: nodeIndex.get(key({ system: a.system, id: a.current_id })), relation: 'exact-target-name' }],
    v3_rationale: a.rationale };
  if (s.current_targets.some(t => swapped.has(`${t.system}\0${t.id}`))) return { ...s,
    current_targets: s.current_targets.map(t => swapped.has(`${t.system}\0${t.id}`) ? { ...t, id: swapped.get(`${t.system}\0${t.id}`), relation: 'laterality-corrected-name' } : t) };
  return s;
});
const tally = (rows, field) => Object.fromEntries([...new Set(rows.map(r => r[field]))].sort(compareText).map(s => [s, rows.filter(r => r[field] === s).length]));
const catalog = { systems, parts };
const neighbors = buildNeighbors(parts, geometry);
const catalogBytes = JSON.stringify(catalog, null, 2) + '\n', neighborBytes = JSON.stringify(neighbors) + '\n';
const provenance = { ...prov0,
  checks: { ...prov0.checks, catalog_rows: parts.length, v018_catalog_rows: prov0.checks.catalog_rows,
    max_v3_additions_bounds_error_metres: maxBoundsError, source_decision_counts: tally(sourceDecisions, 'decision'),
    catalog_sha256: sha256(catalogBytes), neighbors_sha256: sha256(neighborBytes) },
  files, v3: { release: decisions.release, decisions_sha256: sha256(decisionsBytes), v018_catalog_sha256: prov0.checks.catalog_sha256,
    v018_neighbors_sha256: prov0.checks.neighbors_sha256, added_catalog_rows: newRows.map(a => a.current_id),
    replaced_wrong_side_targets: decisions.additions.filter(a => a.replaces_wrong_side_node).map(a => a.current_id),
    laterality_swaps: decisions.renames, edits },
  source_decisions: sourceDecisions };
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, 'parts-catalog.json'), catalogBytes);
await fs.writeFile(path.join(outputDir, 'parts-neighbors.json'), neighborBytes);
await fs.writeFile(path.join(outputDir, 'anatomy-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
await fs.writeFile(path.join(outputDir, 'source-restoration-decisions.json'), restorationBytes);
await fs.writeFile(path.join(outputDir, 'v3-decisions.json'), decisionsBytes);
console.log(JSON.stringify({ catalog_rows: parts.length, added: newRows.length, replaced: provenance.v3.replaced_wrong_side_targets.length,
  swaps: decisions.renames.length, max_bounds_error_m: maxBoundsError, source_decision_counts: provenance.checks.source_decision_counts }, null, 2));
