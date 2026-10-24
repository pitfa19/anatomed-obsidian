import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assembleRegion, buildRegion, MAX_REGION_PARTS } from '../src/region.js';
import { primeNeighbors, type NeighborMap } from '../src/neighbors.js';
import type { RegionDetail, RegionPart } from '../src/shared.js';
import type { PartsCatalog } from '../src/vendor/types.js';

const catalog = JSON.parse(readFileSync(new URL('../assets/parts-catalog.json', import.meta.url), 'utf8')) as PartsCatalog;

function resolve(query: string) {
  return buildRegion(catalog, [query], 'test', { detail: 'isolated' }).payload;
}

function catalogParts(value: unknown, parts: RegionPart[] = []): RegionPart[] {
  if (Array.isArray(value)) {
    for (const item of value) catalogParts(item, parts);
  } else if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    if (
      typeof item.id === 'string'
      && typeof item.name_en === 'string'
      && typeof item.name_lat === 'string'
      && typeof item.system === 'string'
    ) {
      parts.push(item as unknown as RegionPart);
    } else {
      for (const child of Object.values(item)) catalogParts(child, parts);
    }
  }
  return parts;
}

const syntheticParts = [...new Map(catalogParts(catalog).map((part) => [part.id, part])).values()];

function assemblePrimedRegion(focusCount: number, detail: RegionDetail) {
  const focus = syntheticParts.slice(0, focusCount);
  const context = syntheticParts.slice(focusCount, focusCount + 30);
  assert.equal(focus.length, focusCount);
  assert.equal(context.length, 30);

  const neighbors: NeighborMap = {};
  focus.forEach((part, focusIndex) => {
    neighbors[part.id] = Array.from({ length: 14 }, (_, rank) => {
      const neighbor = context[(focusIndex + rank) % context.length];
      return { id: neighbor.id, system: neighbor.system, dist: rank + 1 };
    });
  });
  primeNeighbors(neighbors);

  return assembleRegion(catalog, focus, 'test', { detail });
}

test('generic carotid is declined as ambiguous instead of selecting a branch', () => {
  const payload = resolve('carotid artery');
  assert.equal(payload.parts.length, 0);
  assert.deepEqual(payload.unmatched, []);
  assert.equal(payload.issues?.[0]?.kind, 'ambiguous');
  assert.match(payload.issues?.[0]?.message ?? '', /common, internal, or external/i);
});

test('unsided carotid branches are declined instead of mixing sides', () => {
  for (const query of ['common carotid artery', 'internal carotid artery', 'external carotid artery']) {
    const payload = resolve(query);
    assert.equal(payload.parts.length, 0);
    assert.deepEqual(payload.unmatched, []);
    assert.equal(payload.issues?.[0]?.kind, 'ambiguous');
    assert.deepEqual(payload.issues?.[0]?.options?.map((option) => option.split(' ')[0]), ['left', 'right']);
  }
});

test('Latin Cor expands to heart chambers and never resolves to Cornea', () => {
  const payload = resolve('Cor');
  assert.deepEqual(new Set(payload.parts.map((part) => part.name_en)), new Set(['Right atrium', 'Left atrium', 'Right ventricle', 'Left ventricle']));
  assert.equal(payload.parts.some((part) => part.name_en === 'Cornea'), false);
  assert.equal(payload.expanded?.[0]?.label, 'Heart (four chambers)');
});

test('heart expands to an explicit bounded four-chamber composite', () => {
  const payload = resolve('heart');
  assert.equal(payload.parts.length, 4);
  assert.equal(payload.expanded?.[0]?.label, 'Heart (four chambers)');
});

test('sternum expands to manubrium, body, and xiphoid process', () => {
  const payload = resolve('sternum');
  assert.deepEqual(new Set(payload.parts.map((part) => part.name_en)), new Set(['Manubrium of sternum', 'Body of sternum', 'Xiphoid process']));
});

test('femoral neck and Latin synonym are explicitly unavailable', () => {
  for (const query of ['femoral neck', 'neck of femur', 'Collum femoris']) {
    const payload = resolve(query);
    assert.equal(payload.parts.length, 0);
    assert.equal(payload.issues?.[0]?.kind, 'unavailable');
  }
});

test('invented ligament remains unmatched without substitution', () => {
  const payload = resolve('ligamentum pitlovicense');
  assert.equal(payload.parts.length, 0);
  assert.deepEqual(payload.unmatched, ['ligamentum pitlovicense']);
  assert.equal(payload.issues, undefined);
});

test('assembleRegion caps every detail level at MAX_REGION_PARTS total parts', () => {
  for (const detail of ['isolated', 'related', 'regional'] as const) {
    const payload = assemblePrimedRegion(MAX_REGION_PARTS, detail);
    assert.equal(payload.parts.length, MAX_REGION_PARTS, detail);
  }
});

test('regional assembly fills only remaining capacity with primed neighbors', () => {
  for (const focusCount of [40, 50, 55]) {
    const payload = assemblePrimedRegion(focusCount, 'regional');
    const focus = payload.parts.filter((part) => !part.context);
    const context = payload.parts.filter((part) => part.context);

    assert.equal(payload.parts.length, MAX_REGION_PARTS, `${focusCount} total`);
    assert.equal(focus.length, focusCount, `${focusCount} focus`);
    assert.equal(context.length, MAX_REGION_PARTS - focusCount, `${focusCount} context`);
    assert.deepEqual(focus.map((part) => part.id), syntheticParts.slice(0, focusCount).map((part) => part.id));
  }
});
