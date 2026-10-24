import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildRegion, MAX_REGION_PARTS } from '../src/region.js';
import { resolvePartByQuery, resolveQueryToParts } from '../src/vendor/resolveParts.js';
import type { Part, PartsCatalog } from '../src/vendor/types.js';

const current = JSON.parse(readFileSync(new URL('../assets/parts-catalog.json', import.meta.url), 'utf8')) as PartsCatalog;
const part = (id: string, system: Part['system'] = 'nerves'): Part => ({
  id, system, name_en: id.replace(/\.[lr]$/, ''), name_lat: '',
  side: /\.l$/.test(id) ? 'l' : /\.r$/.test(id) ? 'r' : undefined,
});
// Audited exported source IDs, independent of the resolver's membership table.
const cerebellarIds = [
  'Anterior quadrangular lobule.l', 'Anterior quadrangular lobule.r',
  'Base of peduncle.l', 'Base of peduncle.r', 'Biventral lobule.l', 'Biventral lobule.r',
  'Central lobule', 'Culmen', 'Declive', 'Flocculus.l', 'Flocculus.r', 'Folium of vermis',
  'Gracile lobule.l', 'Gracile lobule.r', 'Inferior semilunar lobule.l', 'Inferior semilunar lobule.r',
  'Lingula of cerebellum', 'Nodule of vermis', 'Peduncle of flocculus.l', 'Peduncle of flocculus.r',
  'Posterior quadrangular lobule.l', 'Posterior quadrangular lobule.r', 'Pyramis of vermis',
  'Superior cerebellar peduncle.l', 'Superior cerebellar peduncle.r',
  'Superior semilunar lobule.l', 'Superior semilunar lobule.r',
  'Tonsil of cerebellum.l', 'Tonsil of cerebellum.r', 'Tuber of vermis', 'Uvula of vermis',
  'Wing of central lobule.l', 'Wing of central lobule.r',
];
const renameCases = [
  ['Hyppoglossal nerve (XII).l', 'Hypoglossal nerve (XII).l'],
  ['Hyppoglossal nerve (XII).r', 'Hypoglossal nerve (XII).r'],
  ['Ophtalmic nerve.l', 'Ophthalmic nerve.l'],
  ['Ophtalmic nerve.r', 'Ophthalmic nerve.r'],
  ['Accessory nucleus of oculomotor nucleus.l', 'Accessory nucleus of oculomotor nerve.l'],
  ['Aqueduct of midbrain (Cerebral aqueduct)', 'Aqueduct of midbrain'],
  ['Communicating branch of median nerve with ulnar nerve.r', '(Communicating branch of median nerve with ulnar nerve).r'],
  ['Hypothalamus.r', 'Hypothalamus'], ['Spinal dura.001', 'Spinal dura'],
  ['Common plantar digital branches of medial plantar nerve.001', 'Common plantar digital branches of medial plantar nerve'],
  ['Zonular fibers-curve.r', 'Zonular fibres.r'],
  ['Posterior interosseus artery.l', 'Posterior interosseous artery.l'],
  ['Recurrent interosseus artery.r', 'Recurrent interosseous artery.r'],
  ['Superior ophtalmic vein.r', 'Superior ophthalmic vein.r'],
  ['Supra-orbital arter.l', 'Supra-orbital artery.l'],
  ['Occiptal sinus', 'Occipital sinus'], ['Left ascending lumbal vein', 'Left ascending lumbar vein'],
  [' Temporal pole.l', 'Temporal pole.l'],
];
const fixture: PartsCatalog = {
  systems: current.systems,
  parts: [
    ...cerebellarIds.map((id) => part(id)), ...renameCases.map(([, id]) => part(id)),
    part('Kidney.l', 'organs'), part('Kidney.r', 'organs'), part('Kidney.001', 'organs'),
    part('Femur.l', 'skeleton'), part('Femur.r', 'skeleton'),
    part('Common carotid artery.l', 'vessels'), part('Common carotid artery.r', 'vessels'),
    part('Superior cerebellar artery.r', 'vessels'), part('Cerebellar nuclei.r'),
    part('Culmen.001'),
  ],
};

for (const [label, catalog] of [['current', current], ['new fixture', fixture]] as const) {
  test(`${label}: exact IDs and prefix/suffix laterality select only the requested kidney`, () => {
    for (const [side, word] of [['l', 'left'], ['r', 'right']] as const) {
      for (const query of [`Kidney.${side}`, `${word} kidney`, `kidney ${word}`]) {
        const result = resolveQueryToParts(catalog, query);
        assert.deepEqual(result?.parts.map((p) => p.id), [`Kidney.${side}`], query);
        assert.equal(resolvePartByQuery(catalog, query)?.id, `Kidney.${side}`);
      }
    }
  });
  test(`${label}: system requests have actionable unsupported responses`, () => {
    for (const query of ['organs', 'nervous system', 'vascular system', 'lymphoid system']) {
      const result = buildRegion(catalog, [query], 'test');
      assert.equal(result.payload.parts.length, 0);
      assert.equal(result.payload.issues?.[0]?.kind, 'unsupported');
      assert.match(result.summary, /Whole-system views are not supported/);
      assert.match(result.summary, /bounded region/);
      assert.equal(resolvePartByQuery(catalog, query), null);
    }
  });
  test(`${label}: sided carotid stays exact and generic carotid stays ambiguous`, () => {
    assert.equal(resolveQueryToParts(catalog, 'left carotid artery')?.issue?.kind, 'ambiguous');
    assert.equal(resolveQueryToParts(catalog, 'common carotid artery')?.issue?.kind, 'ambiguous');
    for (const side of ['left', 'right']) {
      const result = resolveQueryToParts(catalog, `${side} common carotid artery`);
      assert.deepEqual(resolveQueryToParts(catalog, `common carotid artery ${side}`), result);
      const id = result?.parts[0]?.id;
      assert.ok(id === `${side === 'left' ? 'Left' : 'Right'} common carotid artery`
        || id === `Common carotid artery.${side === 'left' ? 'l' : 'r'}`, String(id));
    }
  });
}

test('new fixture: reviewed legacy IDs and names resolve to real renamed nodes', () => {
  for (const [oldId, newId] of renameCases) {
    assert.equal(resolvePartByQuery(fixture, oldId)?.id, newId, oldId);
  }
  assert.equal(resolvePartByQuery(fixture, 'left hyppoglossal nerve (XII)')?.id, 'Hypoglossal nerve (XII).l');
});

test('new fixture: raw numeric suffix is preserved, unknown IDs never fuzzy-substitute', () => {
  assert.equal(resolvePartByQuery(fixture, 'Kidney.001')?.id, 'Kidney.001');
  assert.equal(resolvePartByQuery(fixture, 'Kidney.999'), null);
  assert.equal(resolvePartByQuery(fixture, 'Kydney.r'), null);
});

test('side conflicts and missing sides never select the opposite mirror or a fuzzy neighbor', () => {
  assert.equal(resolveQueryToParts(fixture, 'left kidney.r')?.issue?.kind, 'ambiguous');
  const onlyRight = { ...fixture, parts: [part('Kidney.r', 'organs'), part('Kidney capsule.l', 'organs')] };
  assert.equal(resolveQueryToParts(onlyRight, 'left kidney'), null);
  assert.equal(resolveQueryToParts(onlyRight, 'Kidney.l'), null);
});

test('cerebellum is an explicit bilateral 33-part composite and excludes nearby vessels/nuclei', () => {
  const result = resolveQueryToParts(fixture, 'cerebellum');
  assert.deepEqual(new Set(result?.parts.map((p) => p.id)), new Set(cerebellarIds));
  assert.equal(result?.expanded?.count, 33);
  assert.ok(result!.parts.length < MAX_REGION_PARTS);
});

test('cerebellum side requests and legacy IDs retain the requested side plus midline vermis', () => {
  for (const [side, word] of [['l', 'left'], ['r', 'right']] as const) {
    const expected = cerebellarIds.filter((id) => !/\.[lr]$/.test(id) || id.endsWith(`.${side}`));
    for (const query of [`Cerebellum.${side}`, `${word} cerebellum`, `cerebellum ${word}`]) {
      const result = resolveQueryToParts(fixture, query);
      assert.deepEqual(new Set(result?.parts.map((p) => p.id)), new Set(expected), query);
      assert.equal(result?.parts.length, 21);
    }
  }
});

test('stale cerebellum catalogs are declined rather than returning the known nonexistent node', () => {
  const stale = { systems: [], parts: [part('Cerebellum.l'), part('Cerebellum.r')] };
  for (const query of ['cerebellum', 'Cerebellum.r', 'left cerebellum']) {
    assert.equal(resolveQueryToParts(stale, query)?.issue?.kind, 'unavailable');
    assert.deepEqual(resolveQueryToParts(stale, query)?.parts, []);
  }
});

test('current catalog: every raw ID resolves identically except documented safety/composite queries', () => {
  for (const p of current.parts) {
    if (/^Cerebellum\.[lr]$/.test(p.id)) continue;
    const result = resolveQueryToParts(current, p.id);
    assert.equal(result?.issue, undefined, p.id);
    assert.equal(result?.parts[0]?.id, p.id, p.id);
  }
});

test('current catalog: cerebellum and aliases track regenerated source availability', () => {
  const ids = new Set(current.parts.map((p) => p.id));
  const result = resolveQueryToParts(current, 'cerebellum');
  if (cerebellarIds.every((id) => ids.has(id))) {
    assert.deepEqual(new Set(result?.parts.map((p) => p.id)), new Set(cerebellarIds));
    for (const [oldId, newId] of renameCases) {
      if (ids.has(newId) && !ids.has(oldId)) assert.equal(resolvePartByQuery(current, oldId)?.id, newId, oldId);
    }
  } else {
    assert.equal(result?.issue?.kind, 'unavailable');
  }
});

test('partial cerebellum catalogs never masquerade as the complete composite', () => {
  const partial = { ...fixture, parts: fixture.parts.filter((p) => p.id !== 'Culmen') };
  assert.equal(resolveQueryToParts(partial, 'cerebellum')?.issue?.kind, 'unavailable');
});

test('left/right group expansions retain their own side across cached calls', () => {
  for (const [word, side] of [['left', 'l'], ['right', 'r'], ['left', 'l']] as const) {
    const result = resolveQueryToParts(current, `${word} foot bones`);
    assert.ok(result && result.parts.length > 0);
    assert.ok(result.parts.every((p) => p.side === side), word);
  }
});

test('a mixed unsupported request still resolves valid named anatomy', () => {
  const result = buildRegion(fixture, ['organs', 'Kidney.r'], 'test');
  assert.deepEqual(result.payload.parts.map((p) => p.id), ['Kidney.r']);
  assert.equal(result.payload.issues?.[0]?.kind, 'unsupported');
});
