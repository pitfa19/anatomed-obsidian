import { readFileSync, existsSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { PACK_NAME, RELEASE, SYSTEMS, VERSION, sha256 } from './package-assets.mjs';

const metadata = JSON.parse(readFileSync('src/assetPack.generated.json', 'utf8'));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if ([manifest.version, pkg.version, lock.version, lock.packages[''].version, metadata.version].some((v) => v !== VERSION) || versions[VERSION] !== manifest.minAppVersion) {
  throw new Error(`release versions are not aligned at ${VERSION}`);
}
if (metadata.release !== RELEASE || metadata.pack !== PACK_NAME) throw new Error('wrong release identity');
const expectedPaths = [...SYSTEMS.map((id) => `glb/${id}.glb`), 'parts-neighbors.json'].sort();
if (JSON.stringify(metadata.assets.map((entry) => entry.path).sort()) !== JSON.stringify(expectedPaths)) throw new Error('pack inventory must contain all nine systems');
const bytes = readFileSync(`release-assets/${PACK_NAME}`);
if (bytes.length !== metadata.bytes || sha256(bytes) !== metadata.sha256) throw new Error('asset pack digest mismatch');
const archive = unzipSync(bytes);
if (JSON.stringify(Object.keys(archive).sort()) !== JSON.stringify(expectedPaths)) throw new Error('unexpected or missing asset-pack entries');
for (const { path, bytes: size, sha256: digest } of metadata.assets) {
  if (archive[path].length !== size || sha256(archive[path]) !== digest) throw new Error(`asset-pack content mismatch: ${path}`);
}
const publicPaths = [...expectedPaths, 'parts-catalog.json'].sort();
if (JSON.stringify(metadata.publicObjects.map((entry) => entry.path).sort()) !== JSON.stringify(publicPaths)) throw new Error('invalid public object inventory');
for (const entry of metadata.publicObjects) {
  const packed = entry.path === 'parts-catalog.json' ? readFileSync('assets/parts-catalog.json') : archive[entry.path];
  if (packed.length !== entry.bytes || sha256(packed) !== entry.sha256) throw new Error(`public object mismatch: ${entry.path}`);
  // CI does not have ignored raw GLBs. Locally, ensure a changed source cannot go unnoticed.
  if (existsSync(`assets/${entry.path}`) && sha256(readFileSync(`assets/${entry.path}`)) !== entry.sha256) throw new Error(`source changed since packaging: ${entry.path}`);
}
console.log(JSON.stringify({ version: metadata.version, assetPackBytes: bytes.length, entries: metadata.assets.length, digest: metadata.sha256 }));
