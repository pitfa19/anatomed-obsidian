import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

const expected = new Map([
  ['glb/insertions.glb', 1_383_896],
  ['glb/joints.glb', 1_140_768],
  ['glb/muscles.glb', 2_971_584],
  ['glb/nerves.glb', 5_835_352],
  ['glb/organs.glb', 1_386_016],
  ['glb/regions.glb', 752_024],
  ['glb/skeleton.glb', 1_873_564],
  ['glb/vessels.glb', 5_692_308],
  ['parts-neighbors.json', 5_960_668],
]);
const expectedDigest = 'd4e3662e1d391e8e4ce798fbddcaaa6eba17c6770bc2b0c69ca27609d8a3e9a5';
const version = '0.1.7';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (manifest.version !== version || pkg.version !== version || !versions[version]) {
  throw new Error('release versions are not aligned at 0.1.7');
}

const bytes = readFileSync('release-assets/anatomed-assets-v1.zip');
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== expectedDigest) throw new Error(`asset pack digest mismatch: ${digest}`);

const archive = unzipSync(bytes);
for (const [name, size] of expected) {
  if (!archive[name]) throw new Error(`missing asset-pack entry: ${name}`);
  if (archive[name].byteLength !== size) {
    throw new Error(`asset-pack size mismatch for ${name}: ${archive[name].byteLength} != ${size}`);
  }
}
const extras = Object.keys(archive).filter((name) => !expected.has(name));
if (extras.length) throw new Error(`unexpected asset-pack entries: ${extras.join(', ')}`);

console.log(JSON.stringify({ version, assetPackBytes: bytes.byteLength, entries: expected.size, digest }));
