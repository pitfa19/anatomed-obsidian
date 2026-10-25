// 0.1.9 (v3) GLB edits: node renames (laterality swaps), detaching superseded wrong-side copies,
// and appending reviewed source additions. Every edit is recorded so verifyV3 can undo the
// edits in memory and prove the 0.1.8 binary chunk and JSON graph prefixes are unchanged.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { sha256 } from './geometry.mjs';
import { parseGlb, encodeGlb, appendGlb } from './append-source-additions.mjs';

const FIELDS = ['nodes', 'meshes', 'accessors', 'bufferViews'];
const prefixHashes = (json, counts) => Object.fromEntries(FIELDS.map(f => [f,
  { count: counts?.[f] ?? json[f].length, sha256: sha256(JSON.stringify(json[f].slice(0, counts?.[f] ?? json[f].length))) }]));
export const supersededName = name => `${name} [superseded wrong-side copy, 0.1.9]`;

/** Apply recorded edits to 0.1.8 bytes. `swaps`: [[nameA, nameB]], `retire`: [name], `addition`: GLB bytes or null. */
export function applyV3(baseBytes, { swaps = [], retire = [], addition = null }) {
  const base = parseGlb(baseBytes);
  const json = structuredClone(base.json);
  const scene = json.scene ?? 0;
  const byName = name => { const i = json.nodes.findIndex(n => n.name === name); assert(i >= 0, `node ${name}`);
    assert.equal(json.nodes.filter(n => n.name === name).length, 1, `unique ${name}`); return i; };
  const renames = [], detached = [];
  for (const [a, b] of swaps) {
    const ia = byName(a), ib = byName(b);
    json.nodes[ia].name = b; json.nodes[ib].name = a;
    renames.push({ index: ia, from: a, to: b }, { index: ib, from: b, to: a });
  }
  for (const name of retire) {
    const index = byName(name);
    const position = json.scenes[scene].nodes.indexOf(index);
    assert(position >= 0, `${name} must be a scene root to detach`);
    assert(!json.nodes.some(n => n.children?.includes(index)), `${name} has a parent`);
    renames.push({ index, from: name, to: supersededName(name) });
    json.nodes[index].name = supersededName(name);
    detached.push({ index, position });
  }
  for (const d of [...detached].sort((x, y) => y.position - x.position)) json.scenes[scene].nodes.splice(d.position, 1);
  let bytes = encodeGlb(json, base.bin);
  let appended = null;
  if (addition) { const r = appendGlb(bytes, addition); bytes = r.bytes; appended = { addition_sha256: r.preservation.addition_sha256, added_nodes: r.preservation.added_nodes }; }
  const record = { base_sha256: sha256(baseBytes), base_bin_length: base.bin.length, base_bin_sha256: sha256(base.bin),
    base_buffer_tail: base.json.buffers.slice(1), base_scene: scene, base_roots: base.json.scenes[scene].nodes,
    base_prefixes: prefixHashes(base.json), renames, detached, appended, merged_sha256: sha256(bytes) };
  verifyV3(bytes, record);
  return { bytes, record };
}

/** Undo recorded renames/detaches in memory and compare with the 0.1.8 prefixes. */
export function verifyV3(bytes, r) {
  const { json, bin } = parseGlb(bytes);
  assert.equal(sha256(bytes), r.merged_sha256, 'v3 file hash');
  assert.equal(sha256(bin.subarray(0, r.base_bin_length)), r.base_bin_sha256, '0.1.8 compressed bytes changed');
  assert.deepEqual(json.buffers.slice(1), r.base_buffer_tail);
  const undone = structuredClone(json);
  for (const e of r.renames) { assert.equal(undone.nodes[e.index].name, e.to); undone.nodes[e.index].name = e.from; }
  const roots = undone.scenes[r.base_scene].nodes;
  for (const d of [...r.detached].sort((x, y) => x.position - y.position)) {
    assert(!roots.includes(d.index), 'retired node must not be rendered'); roots.splice(d.position, 0, d.index);
  }
  assert.deepEqual(roots.slice(0, r.base_roots.length), r.base_roots, 'scene roots changed');
  for (const [field, expected] of Object.entries(r.base_prefixes))
    assert.equal(sha256(JSON.stringify(undone[field].slice(0, expected.count))), expected.sha256, `0.1.8 ${field} changed beyond recorded edits`);
  return true;
}

async function main() {
  const [baseDir, decisionsPath, additionsDir, outputDir] = process.argv.slice(2);
  assert(baseDir && decisionsPath && additionsDir && outputDir, 'Usage: node apply-v3-edits.mjs BASE_0.1.8_GLB_DIR V3_DECISIONS ADDITIONS_DIR OUTPUT_GLB_DIR');
  const decisionsBytes = await fs.readFile(decisionsPath), decisions = JSON.parse(decisionsBytes);
  const report = JSON.parse(await fs.readFile(path.join(additionsDir, 'v3-additions-export.json')));
  assert.equal(report.decisions_sha256, sha256(decisionsBytes));
  const systems = [...new Set([...decisions.additions.map(a => a.system), ...decisions.renames.map(r => r.system)])].sort();
  const out = [];
  for (const system of systems) {
    const baseBytes = await fs.readFile(path.join(baseDir, `${system}.glb`));
    const exported = report.systems.find(s => s.system === system);
    const addition = exported ? await fs.readFile(path.join(additionsDir, `${system}-v3-additions.glb`)) : null;
    if (exported) assert.equal(sha256(addition), exported.sha256);
    const swaps = decisions.renames.filter(r => r.system === system).map(r => r.swap);
    const retire = decisions.additions.filter(a => a.system === system && a.replaces_wrong_side_node).map(a => a.current_id);
    const { bytes, record } = applyV3(baseBytes, { swaps, retire, addition });
    await fs.writeFile(path.join(outputDir, `${system}.glb`), bytes);
    out.push({ system, ...record, objects: exported?.objects ?? [] });
    console.log(system, { swaps: swaps.length, retired: retire.length, added: record.appended?.added_nodes ?? 0, sha256: record.merged_sha256.slice(0, 12) });
  }
  await fs.writeFile(path.join(outputDir, 'v3-edits-merged.json'), JSON.stringify({ release: decisions.release,
    source_sha256: decisions.source_sha256, decisions_sha256: sha256(decisionsBytes), blender_version: report.blender_version,
    coordinate_policy: report.coordinate_policy, systems: out }, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
