import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadGeometry, helper, key, compareText, sha256, buildNeighbors } from './geometry.mjs';
import { verifyPreservedGeometry } from './append-source-additions.mjs';

const [auditDir, glbDir, outputDir, restorationPath] = process.argv.slice(2);
assert(auditDir && glbDir && outputDir && restorationPath, 'Usage: node generate.mjs SOURCE_AUDIT_DIR GLB_DIR OUTPUT_ASSETS_DIR RESTORATION_DECISIONS_JSON');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const baselinePath = fileURLToPath(new URL('./baseline-catalog.json', import.meta.url));
const baseline = await read(baselinePath), inventory = await read(path.join(auditDir, 'inventory.json'));
const mapping = await read(path.join(auditDir, 'mapping.json'));
const exported = await read(path.join(glbDir, 'lymphoid-export.json'));
const restorationBytes = await fs.readFile(restorationPath);
const restoration = JSON.parse(restorationBytes);
const additions = await read(path.join(glbDir, 'source-additions-merged.json'));
assert.equal(additions.decisions_sha256, sha256(restorationBytes));
assert.equal(restoration.source_sha256, exported.source_sha256);
const reviewed = new Map(restoration.rows.map(r => [r.source_id, r]));
assert.equal(inventory.objects.length, 7184);
assert.equal(exported.exported.length, 160);
assert.equal(exported.source_sha256, mapping.source_blend_sha256);
const sources = new Map(inventory.objects.map(o => [o.name, o]));
const originalMapping = new Map(mapping.objects.map(o => [o.source_name, o]));
const systems = [...baseline.systems, { id: 'lymphoid', label_en: 'Lymphoid', label_hr: 'Limfni sustav', glb: '', tint: '#73b982' }];
const parts = [], geometry = new Map(), decisions = [], files = [], rawTargets = new Map();
const convertedNodeDecisions = [];
const originalByKey = new Map(baseline.parts.map(p => [key(p), p]));
const finalByOld = new Map();
for (const system of systems) {
  const model = await loadGeometry(path.join(glbDir, `${system.id}.glb`));
  const originalFile = mapping.files.find(f => f.system === system.id);
  const supplemental = additions.systems.find(s => s.system === system.id);
  if (supplemental) {
    assert.equal(supplemental.original_sha256, originalFile.sha256);
    verifyPreservedGeometry(await fs.readFile(path.join(glbDir, `${system.id}.glb`)), supplemental);
  } else if (originalFile) assert.equal(model.sha256, originalFile.sha256, `Existing ${system.id} geometry changed`);
  else assert.equal(model.sha256, exported.glb_sha256);
  // Cache keys use the actual content hash, including unchanged legacy files.
  system.glb = `/models/glb/${system.id}.glb?v=${model.sha256.slice(0, 8)}`;
  const old = baseline.parts.filter(p => p.system === system.id);
  const rebuild = ['nerves', 'vessels', 'lymphoid'].includes(system.id);
  let candidates;
  if (rebuild) {
    candidates = [];
    for (const row of model.nodes.filter(n => n.rawName)) {
      const source = sources.get(row.rawName), g = model.describe(row);
      const reason = helper(row.rawName) || source?.converter_helper_exclusion.excluded ? 'helper-label-excluded'
        : !row.obj.isMesh || !g.positive ? 'no-positive-renderable-surface' : 'included-exact-renderable-node';
      convertedNodeDecisions.push({ system: system.id, id: row.rawName, node_index: row.rawIndex, decision: reason });
      if (reason !== 'included-exact-renderable-node') continue;
      assert(source, `Converted object lacks source identity: ${row.rawName}`);
      const exact = originalByKey.get(key({ system: system.id, id: row.rawName }));
      const normalized = old.filter(p => p.id.trim() === row.rawName.trim());
      const prior = exact ?? (normalized.length === 1 ? normalized[0] : null);
      const side = row.rawName.match(/\.([lr])$/)?.[1];
      const part = prior ? { ...prior, id: row.rawName } : { id: row.rawName, system: system.id,
        name_en: row.rawName.replace(/\.([lr])$/, '').trim(), name_lat: '', ...(side ? { side } : {}) };
      candidates.push(part);
      if (prior) finalByOld.set(key(prior), part);
    }
    candidates.sort((a, b) => compareText(a.id, b.id));
  } else candidates = old.filter(p => !helper(p.id) && model.lookup(p.id) && model.describe(model.lookup(p.id)).positive);
  for (const record of supplemental?.objects ?? []) {
    assert.equal(reviewed.get(record.source_id)?.decision, 'restore-confirmed-missing-distinct-source-surface');
    assert(!candidates.some(p => p.id === record.current_id));
    const side = record.current_id.match(/\.([lr])$/)?.[1];
    candidates.push({ id: record.current_id, system: system.id,
      name_en: record.current_id.replace(/\.([lr])$/, '').trim(), name_lat: '', ...(side ? { side } : {}) });
  }
  for (const p of candidates) {
    const row = model.lookup(p.id);
    assert(row, `Ambiguous or missing decoded target: ${p.id}`);
    const g = model.describe(row);
    assert(g.positive && !helper(p.id), `Invalid target ${p.id}`);
    geometry.set(key(p), g); parts.push(p);
    if (originalByKey.has(key(p))) finalByOld.set(key(p), p);
    for (const index of new Set([row.rawIndex, ...g.rawIndices])) {
      const name = model.raw.nodes[index]?.name;
      if (name) rawTargets.set(name, [...(rawTargets.get(name) ?? []), { system: p.system, id: p.id, node_index: index,
        relation: index === row.rawIndex ? 'exact-target-name' : 'named-mesh-descendant-of-target' }]);
    }
  }
  for (const p of old) {
    const target = finalByOld.get(key(p)), row = model.lookup(p.id);
    decisions.push({ original: p, decision: target ? (target.id === p.id ? 'retained' : 'unique-whitespace-identity-corrected')
      : helper(p.id) ? 'omitted-helper-label' : !row ? 'omitted-stale-fbx-id-no-current-target'
      : 'omitted-no-positive-renderable-surface', targets: target ? [{ system: target.system, id: target.id }] : [] });
  }
  files.push({ system: system.id, sha256: model.sha256, original_sha256: originalFile?.sha256 ?? null,
    existing_geometry_unchanged: !!originalFile, original_file_unchanged: !!originalFile && !supplemental,
    preservation: supplemental ? 'Original binary chunk and nodes/meshes/accessors/bufferViews prefixes preserved exactly; verified source additions appended.' : null,
    catalog_parts: candidates.length });
  model.dispose();
  console.log(`JCODE_PROGRESS ${JSON.stringify({ current: files.length, total: systems.length, message: `${system.id}: ${candidates.length} positive catalog targets` })}`);
}
assert.equal(new Set(parts.map(p => p.id)).size, parts.length, 'Neighbor format requires globally unique IDs');
for (const name of exported.already_in_organs) {
  assert(parts.some(p => p.system === 'organs' && p.id === name));
  assert(!parts.some(p => p.system === 'lymphoid' && p.id === name));
}
assert.equal(parts.filter(p => p.system === 'lymphoid').length, 160);
// Validate export coordinates against the original enabled source geometry, Z-up to Y-up.
let maxLymphoidBoundsErrorMetres = 0;
let maxAdditionsBoundsErrorMetres = 0;
for (const record of [...exported.exported, ...additions.systems.flatMap(s => s.objects)]) {
  const actual = geometry.get(key({ system: record.system, id: record.current_id })).bounds, { min, max } = record.source_world_bounds;
  const expected = [[min[0], min[2], -max[1]], [max[0], max[2], -min[1]]];
  const error = Math.max(...actual.flat().map((v, i) => Math.abs(v - expected.flat()[i])));
  if (record.system === 'lymphoid') maxLymphoidBoundsErrorMetres = Math.max(maxLymphoidBoundsErrorMetres, error);
  else maxAdditionsBoundsErrorMetres = Math.max(maxAdditionsBoundsErrorMetres, error);
  assert(error < 0.00001, `Source export coordinate mismatch ${record.source_id}: ${error} m`);
}
const sourceDecisions = inventory.objects.map(o => {
  let targets = rawTargets.get(o.name) ?? [];
  const review = reviewed.get(o.name);
  if (review?.decision === 'covered-renamed-anatomical-counterpart-surface-differences') {
    targets = (rawTargets.get(review.current_mesh_id) ?? []).filter(t => t.id === review.current_id)
      .map(t => ({ ...t, relation: 'reviewed-renamed-anatomical-counterpart-not-exact-surface-equivalence' }));
    assert(targets.length > 0);
  }
  const prior = originalMapping.get(o.name);
  const excluded = o.converter_helper_exclusion.excluded;
  const positive = (o.evaluated_enabled?.faces ?? 0) > 0;
  const decision = excluded ? 'excluded-original-helper-or-nongeometry-type'
    : !positive ? 'excluded-no-source-surface'
    : review?.decision.startsWith('unresolved-') ? review.decision
    : review?.decision.startsWith('covered-') ? review.decision
    : review?.decision.startsWith('restore-') ? 'included-restored-reviewed-source-surface'
    : targets.length ? 'included-exact-name-or-named-descendant'
    : 'unresolved-source-identity-not-automatically-added';
  return { source_id: o.name, type: o.type, decision, source_faces: o.evaluated_enabled?.faces ?? 0,
    helper_reasons: o.converter_helper_exclusion.reasons, current_targets: targets,
    ...(review ? { source_review_decision: review.decision, source_review_rationale: review.rationale } : {}),
    prior_named_geometry_evidence: prior.glb_geometry_evidence };
});
const tally = (rows, field) => Object.fromEntries([...new Set(rows.map(r => r[field]))].sort(compareText).map(s => [s, rows.filter(r => r[field] === s).length]));
const catalog = { systems, parts };
const neighbors = buildNeighbors(parts, geometry);
const catalogBytes = JSON.stringify(catalog, null, 2) + '\n', neighborBytes = JSON.stringify(neighbors) + '\n';
const provenance = { schema_version: 1, source_blend_sha256: exported.source_sha256,
  inputs: { inventory_sha256: sha256(await fs.readFile(path.join(auditDir, 'inventory.json'))), mapping_sha256: sha256(await fs.readFile(path.join(auditDir, 'mapping.json'))), baseline_catalog_sha256: sha256(await fs.readFile(baselinePath)) },
  policy: { geometry: 'Six original GLBs preserved bytewise. Muscles/organs retain original binary buffers and graph/accessor prefixes exactly with 123 reviewed missing source surfaces appended. Also 160 missing lymphoid objects exported. No bounds-only identity aliases or duplicate source-candidate exports.',
    identities: 'Converted systems use exact source/raw renderable node names. Existing exact display metadata retained, unique trim-only match metadata transferred. No guessed translation.',
    omissions: 'Helper labels and zero-face/no-target catalog rows are explicitly omitted. Unresolved historical source identities are recorded, not declared absent.',
    neighbors: '30 nearest decoded world-space vertex AABBs, Euclidean box separation in metres rounded to 4 decimals. Insertions excluded from sources and candidates, as in the legacy pipeline. Stable catalog-order tie break. This is not anatomical contact or surface distance.',
    coverage: 'Every original source object and every original catalog row has one decision. Exact-name matches are structural evidence, not a claim of anatomical surface equivalence.' },
  checks: { catalog_rows: parts.length, all_targets_positive_finite: true, original_source_objects: sourceDecisions.length,
    original_catalog_rows: decisions.length, unique_catalog_ids: true, max_lymphoid_bounds_error_metres: maxLymphoidBoundsErrorMetres,
    max_source_additions_bounds_error_metres: maxAdditionsBoundsErrorMetres,
    reviewed_source_candidates: restoration.summary,
    source_decision_counts: tally(sourceDecisions, 'decision'), catalog_decision_counts: tally(decisions, 'decision'),
    catalog_sha256: sha256(catalogBytes), neighbors_sha256: sha256(neighborBytes) },
  files, lymphoid_export: exported, source_additions: additions,
  source_restoration_decisions_sha256: sha256(restorationBytes),
  catalog_decisions: decisions, converted_node_decisions: convertedNodeDecisions, source_decisions: sourceDecisions };
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, 'parts-catalog.json'), catalogBytes);
await fs.writeFile(path.join(outputDir, 'parts-neighbors.json'), neighborBytes);
await fs.writeFile(path.join(outputDir, 'anatomy-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
await fs.writeFile(path.join(outputDir, 'source-restoration-decisions.json'), restorationBytes);
console.log(JSON.stringify(provenance.checks, null, 2));
