import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGeometry, boxDistance, buildNeighbors, helper, key } from './geometry.mjs';
import { appendGlb, parseGlb, encodeGlb, verifyPreservedGeometry } from './append-source-additions.mjs';

function fixture(positions = [0, 0, 0, 1, 0, 0, 0, 1, 0], options = {}) {
  const bin = Buffer.from(new Float32Array(positions).buffer);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Anatomical container', children: [1], translation: [2, 3, 4] },
      { name: 'Actual surface.l', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] };
  if (options.helper) json.nodes[1].name = 'helper-line';
  if (options.empty) delete json.nodes[1].mesh;
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)]);
  const out = Buffer.alloc(12 + 8 + padded.length + 8 + bin.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); padded.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + padded.length); out.writeUInt32LE(0x004e4942, 24 + padded.length); bin.copy(out, 28 + padded.length);
  return out;
}

test('decoded named containers retain positive descendant geometry and world coordinates', async () => {
  const m = await loadGeometry(fixture());
  const g = m.describe(m.lookup('Anatomical container'));
  assert(g.positive); assert.equal(g.positiveTriangles, 1);
  assert.deepEqual(g.bounds, [[2, 3, 4], [3, 4, 4]]);
  assert.equal(m.lookup('Actual surface.l').rawName, 'Actual surface.l'); m.dispose();
});
test('zero-area triangles are not positive selectable surfaces', async () => {
  const m = await loadGeometry(fixture([0, 0, 0, 1, 0, 0, 2, 0, 0]));
  assert.equal(m.describe(m.lookup('Actual surface.l')).positive, false); m.dispose();
});
test('nonfinite vertex data is rejected despite finite accessor metadata', async () => {
  const m = await loadGeometry(fixture([NaN, 0, 0, 1, 0, 0, 0, 1, 0]));
  assert.equal(m.describe(m.lookup('Actual surface.l')).positive, false);
  assert.equal(m.describe(m.lookup('Actual surface.l')).invalid, true); m.dispose();
});
test('helper-only descendants and empty nodes are not selectable geometry', async () => {
  for (const options of [{ helper: true }, { empty: true }]) {
    const m = await loadGeometry(fixture(undefined, options));
    assert.equal(m.describe(m.lookup('Anatomical container')).positive, false); m.dispose();
  }
});
test('additive GLB merge preserves original buffers and graph while adding exact geometry', async () => {
  const original = fixture(), parsed = parseGlb(fixture());
  parsed.json.nodes[0].name = 'New container'; parsed.json.nodes[1].name = 'New anatomy.r';
  parsed.json.nodes[0].translation = [5, 6, 7];
  const { bytes, preservation } = appendGlb(original, encodeGlb(parsed.json, parsed.bin));
  assert(verifyPreservedGeometry(bytes, preservation));
  assert.deepEqual(parseGlb(bytes).bin.subarray(0, parseGlb(original).bin.length), parseGlb(original).bin);
  const model = await loadGeometry(bytes);
  assert.deepEqual(model.describe(model.lookup('Actual surface.l')).bounds, [[2, 3, 4], [3, 4, 4]]);
  assert.deepEqual(model.describe(model.lookup('New anatomy.r')).bounds, [[5, 6, 7], [6, 7, 7]]);
  model.dispose();
  assert.throws(() => appendGlb(original, original), /Duplicate original node/);
});

test('helper suffixes exclude labels but retain laterality', () => {
  assert(helper('Cardiovascular system.g')); assert(helper('Leader.j'));
  assert(!helper('Median nerve.l')); assert(!helper('Median nerve.r'));
});
test('AABB distance is separation, zero for overlap, stable catalog ties', () => {
  assert.equal(boxDistance([[0, 0, 0], [1, 1, 1]], [[2, 1, 1], [3, 2, 2]]), 1);
  assert.equal(boxDistance([[0, 0, 0], [1, 1, 1]], [[0.5, 0.5, 0.5], [3, 3, 3]]), 0);
  const parts = ['A', 'C', 'B'].map(id => ({ id, system: 'lymphoid' }));
  const geometry = new Map(parts.map(p => [key(p), { bounds: [[0, 0, 0], [1, 1, 1]] }]));
  parts.push({ id: 'insertion', system: 'insertions' });
  geometry.set(key(parts.at(-1)), { bounds: [[0, 0, 0], [1, 1, 1]] });
  const neighbors = buildNeighbors(parts, geometry, 2);
  assert.deepEqual(neighbors.A.map(n => n.id), ['C', 'B']);
  assert.equal(neighbors.insertion, undefined);
  assert(Object.values(neighbors).flat().every(n => n.system !== 'insertions'));
});
