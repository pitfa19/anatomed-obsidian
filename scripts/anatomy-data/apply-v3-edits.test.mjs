import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadGeometry } from './geometry.mjs';
import { parseGlb, encodeGlb } from './append-source-additions.mjs';
import { applyV3, verifyV3, supersededName } from './apply-v3-edits.mjs';

// Scene-root meshes: 'Patch.l' is a wrong-side copy at x=-1 like 'Patch.r'; 'Ligament.l/.r' labels are inverted.
function fixture() {
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const bin = Buffer.from(new Float32Array(tri).buffer);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1, 2, 3] }],
    nodes: [{ name: 'Patch.r', mesh: 0, translation: [-1, 0, 0] }, { name: 'Patch.l', mesh: 0, translation: [-1, 0, 0] },
      { name: 'Ligament.l', mesh: 0, translation: [-2, 0, 0] }, { name: 'Ligament.r', mesh: 0, translation: [2, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }], buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] };
  return encodeGlb(json, bin);
}
function addition() {
  const p = parseGlb(fixture());
  p.json.scenes = [{ nodes: [0] }];
  p.json.nodes = [{ name: 'Patch.l', mesh: 0, translation: [3, 0, 0] }];
  return encodeGlb(p.json, p.bin);
}

test('v3 edits retire the wrong-side copy, add the real left patch, and swap inverted labels', async () => {
  const base = fixture();
  const { bytes, record } = applyV3(base, { swaps: [['Ligament.l', 'Ligament.r']], retire: ['Patch.l'], addition: addition() });
  assert(verifyV3(bytes, record));
  const m = await loadGeometry(bytes);
  const centre = id => { const b = m.describe(m.lookup(id)).bounds; return (b[0][0] + b[1][0]) / 2; };
  assert(centre('Patch.l') > 0, 'new left patch is on body-left (+x)');
  assert(centre('Patch.r') < 0);
  assert(centre('Ligament.l') > 0 && centre('Ligament.r') < 0, 'labels swapped to match position');
  const json = parseGlb(bytes).json;
  const retired = json.nodes.findIndex(n => n.name === supersededName('Patch.l'));
  assert(retired >= 0 && !json.scenes[0].nodes.includes(retired), 'superseded copy is kept but never rendered');
  assert.deepEqual(parseGlb(bytes).bin.subarray(0, parseGlb(base).bin.length), parseGlb(base).bin, 'original bytes are a prefix');
  m.dispose();
});

test('v3 verification rejects unrecorded changes to original nodes', () => {
  const { bytes, record } = applyV3(fixture(), { swaps: [['Ligament.l', 'Ligament.r']] });
  const p = parseGlb(bytes); p.json.nodes[0].translation = [9, 9, 9];
  const tampered = encodeGlb(p.json, p.bin);
  assert.throws(() => verifyV3(tampered, { ...record, merged_sha256: record.merged_sha256 }), /v3 file hash/);
  const rehashed = { ...record, merged_sha256: crypto.createHash('sha256').update(tampered).digest('hex') };
  assert.throws(() => verifyV3(tampered, rehashed), /nodes changed beyond recorded edits/);
});

test('retiring a node that is not a scene root is refused', () => {
  const p = parseGlb(fixture());
  p.json.nodes.push({ name: 'Group', children: [1] }); p.json.scenes[0].nodes = [0, 2, 3, 4];
  assert.throws(() => applyV3(encodeGlb(p.json, p.bin), { retire: ['Patch.l'] }), /scene root/);
});
