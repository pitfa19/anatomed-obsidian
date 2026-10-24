import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { sha256 } from './geometry.mjs';

export function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const length = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString());
  const offset = 20 + length;
  assert.equal(bytes.readUInt32LE(offset + 4), 0x004e4942);
  return { json, bin: bytes.subarray(offset + 8, offset + 8 + bytes.readUInt32LE(offset)) };
}
export function encodeGlb(json, bin) {
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)]);
  const data = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
  const out = Buffer.alloc(12 + 8 + padded.length + 8 + data.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); padded.copy(out, 20);
  out.writeUInt32LE(data.length, 20 + padded.length); out.writeUInt32LE(0x004e4942, 24 + padded.length); data.copy(out, 28 + padded.length);
  return out;
}
export function appendGlb(originalBytes, additionBytes) {
  const original = parseGlb(originalBytes), addition = parseGlb(additionBytes);
  const j = structuredClone(original.json), a = addition.json;
  assert.equal(a.buffers.length, 1);
  assert.equal(a.buffers[0].uri, undefined);
  for (const field of ['skins', 'animations', 'materials', 'textures', 'images', 'cameras', 'extensionsUsed', 'extensionsRequired'])
    assert(!(a[field]?.length), `Unsupported supplemental ${field}`);
  const nodeOffset = j.nodes.length, meshOffset = j.meshes.length, accessorOffset = j.accessors.length, viewOffset = j.bufferViews.length;
  const byteOffset = original.bin.length;
  const prefixes = Object.fromEntries(['nodes', 'meshes', 'accessors', 'bufferViews'].map(field => [field,
    { count: j[field].length, sha256: sha256(JSON.stringify(j[field])) }]));
  const existingNames = new Set(j.nodes.map(n => n.name).filter(Boolean));
  for (const n of a.nodes) { assert(!existingNames.has(n.name), `Duplicate original node ${n.name}`); assert(n.skin === undefined); }
  j.bufferViews.push(...a.bufferViews.map(v => {
    assert.equal(v.buffer, 0); assert(!v.extensions);
    return { ...v, buffer: 0, byteOffset: (v.byteOffset ?? 0) + byteOffset };
  }));
  j.accessors.push(...a.accessors.map(v => { assert(!v.sparse); return { ...v, bufferView: v.bufferView + viewOffset }; }));
  j.meshes.push(...a.meshes.map(m => ({ ...m, primitives: m.primitives.map(p => {
    assert(!p.targets && !p.extensions && p.material === undefined);
    return { ...p, attributes: Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, v + accessorOffset])),
      ...(p.indices === undefined ? {} : { indices: p.indices + accessorOffset }) };
  }) })));
  j.nodes.push(...a.nodes.map(n => ({ ...n, ...(n.mesh === undefined ? {} : { mesh: n.mesh + meshOffset }),
    ...(n.children ? { children: n.children.map(i => i + nodeOffset) } : {}) })));
  const scene = j.scene ?? 0;
  const originalRoots = [...j.scenes[scene].nodes];
  j.scenes[scene].nodes.push(...a.scenes[a.scene ?? 0].nodes.map(n => n + nodeOffset));
  j.buffers[0].byteLength = byteOffset + addition.bin.length;
  const bin = Buffer.concat([original.bin, addition.bin]);
  const bytes = encodeGlb(j, bin);
  const preservation = { original_sha256: sha256(originalBytes), addition_sha256: sha256(additionBytes),
    original_bin_length: original.bin.length, original_bin_sha256: sha256(original.bin),
    original_buffer_tail: original.json.buffers.slice(1), original_scene: scene, original_roots: originalRoots,
    original_prefixes: prefixes, merged_sha256: sha256(bytes), added_nodes: a.nodes.length };
  verifyPreservedGeometry(bytes, preservation);
  return { bytes, preservation };
}
export function verifyPreservedGeometry(bytes, p) {
  const { json, bin } = parseGlb(bytes);
  assert.equal(sha256(bytes), p.merged_sha256);
  assert.equal(sha256(bin.subarray(0, p.original_bin_length)), p.original_bin_sha256, 'Original compressed bytes changed');
  for (const [field, expected] of Object.entries(p.original_prefixes))
    assert.equal(sha256(JSON.stringify(json[field].slice(0, expected.count))), expected.sha256, `Original ${field} changed`);
  assert.deepEqual(json.buffers.slice(1), p.original_buffer_tail);
  assert.deepEqual(json.scenes[p.original_scene].nodes.slice(0, p.original_roots.length), p.original_roots);
  return true;
}

async function main() {
  const [originalDir, additionsDir, outputDir] = process.argv.slice(2);
  assert(originalDir && additionsDir && outputDir, 'Usage: node append-source-additions.mjs ORIGINAL_GLB_DIR ADDITIONS_DIR OUTPUT_GLB_DIR');
  const report = JSON.parse(await fs.readFile(path.join(additionsDir, 'source-additions-export.json')));
  const systems = [];
  for (const addition of report.systems) {
    const old = await fs.readFile(path.join(originalDir, `${addition.system}.glb`));
    const extra = await fs.readFile(path.join(additionsDir, `${addition.system}-additions.glb`));
    assert.equal(sha256(extra), addition.sha256);
    const { bytes, preservation } = appendGlb(old, extra);
    await fs.writeFile(path.join(outputDir, `${addition.system}.glb`), bytes);
    systems.push({ system: addition.system, ...preservation, objects: addition.objects });
    console.log(addition.system, preservation.added_nodes, preservation.merged_sha256);
  }
  await fs.writeFile(path.join(outputDir, 'source-additions-merged.json'), JSON.stringify({ ...report, systems }, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
