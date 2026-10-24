import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildRegion } from '../src/region.js';
import { resolveQueryToParts } from '../src/vendor/resolveParts.js';
import { STALE_ID_ALIASES, STALE_ID_UNAVAILABLE } from '../src/vendor/staleIds.js';
import type { PartsCatalog } from '../src/vendor/types.js';

const catalog = JSON.parse(readFileSync(new URL('../assets/parts-catalog.json', import.meta.url), 'utf8')) as PartsCatalog;
// Independent transcription of all appSelectable + missing_node entries in
// geometry/decoded-geometry.json from the 2026-10-24 production audit.
const staleIds = [
  ' Temporal pole.l', ' Temporal pole.r',
  'Accessory nucleus of oculomotor nucleus.l', 'Accessory nucleus of oculomotor nucleus.r',
  'Aqueduct of midbrain (Cerebral aqueduct)', 'Cerebellum.l', 'Cerebellum.r',
  'Common plantar digital branches of medial plantar nerve.001',
  'Communicating branch of median nerve with ulnar nerve.l', 'Communicating branch of median nerve with ulnar nerve.r',
  'Hypothalamus.r', 'Hyppoglossal nerve (XII).l', 'Hyppoglossal nerve (XII).r',
  'Mamillary body', 'Ophtalmic nerve.l', 'Ophtalmic nerve.r', 'Spinal dura.001',
  'Vestibular nerve', 'Zonular fibers-curve.r',
  '?.r', '[Right posterolateral branch]', 'Anterior branch of renal artery',
  'Anterior interventricular artery (Left ant descending artery)',
  'Anterior parietal artery.l', 'Anterior parietal artery.r',
  'Artery of postcentral sulcus.l', 'Artery of postcentral sulcus.r',
  'Deep branch of transverse cervical artery.l', 'Deep branch of transverse cervical artery.r',
  'Descending branch of lateral circumflex femoral artery.001',
  'External pudendal vein.002', 'External pudendal vein.l', 'External pudendal vein.r',
  'Inferior sagittal sinus.l', 'Inferior vena cava-ab', 'Inferior vena cava-th',
  'Insular branches of middle cerebral artery (M2).l', 'Left ascending lumbal vein',
  'Left superior intercostal veins.l', 'Left superior pulmonary vein.001',
  'Lumbar arteries', 'Lumbar branch of iliolumbar artery',
  'Middle cerebral artery (M3 segment).r', 'Middle temporal branch.l', 'Middle temporal branch.r',
  'Occiptal sinus', 'Posterior branch of renal artery', 'Posterior intercostal arteries',
  'Posterior interosseus artery.l', 'Posterior interosseus artery.r',
  'Recurrent interosseus artery.l', 'Recurrent interosseus artery.r',
  'Right superior intercostal veins', 'Right testicular artery.001.l', 'Right testicular vein.001',
  'Spinal branch of iliolumbar artery', 'Subcostal artery', 'Subscapular vein',
  'Superficial branch of transverse cervical artery.001', 'Superior gluteal vein.l', 'Superior gluteal vein.r',
  'Superior ophtalmic vein.r', 'Supra-orbital arter.l', 'Supra-orbital arter.r',
  'Ulnar recurrent artery.l', 'Ulnar recurrent artery.r',
];

test('compatibility policy accounts for exactly all 66 audited missing-node references', () => {
  assert.equal(staleIds.length, 66);
  assert.deepEqual(new Set(staleIds.map((id) => id.trim().toLowerCase())), new Set([
    ...Object.keys(STALE_ID_ALIASES), ...Object.keys(STALE_ID_UNAVAILABLE), 'cerebellum.l', 'cerebellum.r',
  ]));
  assert.equal(Object.keys(STALE_ID_ALIASES).length, 42);
  assert.equal(Object.keys(STALE_ID_UNAVAILABLE).length, 22);
});

for (const id of staleIds) {
  test(`saved reference: ${id}`, () => {
    const key = id.trim().toLowerCase();
    const result = buildRegion(catalog, [id], 'test');
    assert.deepEqual(result.payload.unmatched, [], 'stale IDs must never silently become unmatched');
    if (key in STALE_ID_UNAVAILABLE) {
      assert.deepEqual(result.payload.parts, []);
      assert.equal(result.payload.issues?.[0]?.kind, 'unavailable');
      assert.match(result.summary, /no verified one-to-one replacement/);
    } else if (key.startsWith('cerebellum.')) {
      assert.equal(result.payload.parts.length, 21);
      assert.ok(result.payload.parts.every((p) => !p.side || p.side === key.at(-1)));
    } else {
      assert.deepEqual(result.payload.parts.map((p) => p.id), [STALE_ID_ALIASES[key]]);
      assert.equal(result.payload.issues, undefined);
    }
    for (const p of result.payload.parts) assert.ok(catalog.parts.some((candidate) => candidate.id === p.id));
  });
}

test('all 66 saved references remain explicit when target data is absent', () => {
  const empty: PartsCatalog = { systems: [], parts: [] };
  for (const id of staleIds) {
    const result = resolveQueryToParts(empty, id);
    assert.deepEqual(result?.parts, [], id);
    assert.equal(result?.issue?.kind, 'unavailable', id);
  }
});

test('unsafe old references cannot fall through to plausible fuzzy neighbors', () => {
  for (const id of Object.keys(STALE_ID_UNAVAILABLE)) {
    const bait: PartsCatalog = { systems: [], parts: [{ id: `${id} neighbor`, name_en: `${id} neighbor`, name_lat: id, system: 'vessels' }] };
    assert.equal(resolveQueryToParts(bait, id)?.issue?.kind, 'unavailable', id);
  }
});

test('safe renamed references never fall back to the stale node if target is missing', () => {
  for (const id of Object.keys(STALE_ID_ALIASES).filter((id) => !id.startsWith('temporal pole.'))) {
    const stale: PartsCatalog = { systems: [], parts: [{ id, name_en: id, name_lat: '', system: 'vessels' }] };
    assert.equal(resolveQueryToParts(stale, id)?.issue?.kind, 'unavailable', id);
  }
});
