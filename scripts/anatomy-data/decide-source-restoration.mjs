import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { sha256 } from './geometry.mjs';
const [evidencePath, outputPath] = process.argv.slice(2);
assert(evidencePath && outputPath, 'Usage: node decide-source-restoration.mjs EVIDENCE_JSON OUTPUT_JSON');
const bytes = await fs.readFile(evidencePath), evidence = JSON.parse(bytes);
assert.equal(evidence.rows.length, 125);
assert.equal(evidence.rows.filter(r => r.system === 'muscles').length, 119);
assert.equal(evidence.rows.filter(r => r.collections.some(c => ['Bursae', 'Tendon sheaths'].includes(c))).length, 116);
const absentVisceral = new Set(['Laryngopharynx', 'Nasopharynx', 'Oropharynx', 'Mucosa of nasal cavity']);
const bronchus = 'Medial basal segmental bronchus of right lung (BVII)';
const rows = evidence.rows.map(r => {
  if (r.system === 'muscles') {
    assert(r.fraction_within_mm['0.3'] < 0.54 && r.nearest_surface_distance_metres.p95 > 0.0008);
    return { ...r, decision: 'restore-confirmed-missing-distinct-source-surface', current_id: r.source_id,
      rationale: r.collections.some(c => ['Bursae', 'Tendon sheaths'].includes(c))
        ? 'Exact source Bursae/Tendon sheaths collection anatomy. Original export retains only helper-line collection labels, no anatomical member counterparts. Actual surface samples are not covered by existing nearby muscles.'
        : 'Distinct named source fascia/fibrous sheath absent from original export. Actual nearest surfaces are different named muscles/aponeuroses, with substantial surface differences. Restore original object, not a bounds-inferred substitute.' };
  }
  if (absentVisceral.has(r.source_id)) {
    assert(r.fraction_within_mm['0.3'] < 0.11 && r.nearest_surface_distance_metres.p95 > 0.011);
    return { ...r, decision: 'restore-confirmed-missing-distinct-source-surface', current_id: r.source_id,
      rationale: 'No named anatomical counterpart. Existing pharynx group has only a helper line. Source surface is predominantly millimetres to centimetres from unrelated existing organ surfaces, ruling out a simply renamed/merged copy at source coordinates.' };
  }
  if (r.source_id === bronchus) {
    assert.equal(r.nearest_existing_meshes[0].id, 'Medial basal segmental bronchus of right lung');
    assert(r.nearest_existing_meshes[0].sample_count / r.samples > 0.97);
    assert(r.fraction_within_mm['1'] > 0.98);
    return { ...r, decision: 'covered-renamed-anatomical-counterpart-surface-differences',
      current_id: 'Medial basal segmental bronchus of right lung', current_mesh_id: 'Medial basal segmental bronchus of right lung',
      rationale: 'Distinct anatomical name matches after removal of the segment code. The existing mesh is directly selectable and also a descendant of Right inferior lobar bronchus. 97% of samples select that mesh and 98.5% lie within 1mm of existing anatomy. Geometric equality is not claimed, and no duplicate bronchus is added.' };
  }
  assert.equal(r.source_id, 'Pleura');
  return { ...r, decision: 'unresolved-possible-merged-or-adjacent-lung-surface', current_id: null,
    rationale: 'Most source samples lie within 2mm of existing lung lobes, but the evidence cannot distinguish an omitted pleural membrane from a merged or differently tessellated lung surface. No anatomical equivalence is asserted and no duplicate shell is added.' };
});
assert.equal(rows.filter(r => r.decision.startsWith('restore-')).length, 123);
const result = { schema_version: 1, source_sha256: evidence.source_sha256, evidence_sha256: sha256(bytes),
  method: evidence.method, target_files: evidence.target_files, rows,
  summary: { reviewed: 125, restored: 123, muscles_restored: 119, organs_restored: 4,
    named_counterpart_no_duplicate: 1, unresolved_possible_merged_surface: 1,
    limitation: 'Nearest-surface measurements support reviewed identity decisions, not a universal anatomical-equivalence threshold. Remaining unreviewed source identities stay unresolved.' } };
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
console.log(result.summary);
