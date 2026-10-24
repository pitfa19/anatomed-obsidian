import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

export const RELEASE = 'releases/2026-10-24-v2';
export const PACK_NAME = 'anatomed-assets-v2.zip';
export const SYSTEMS = ['insertions', 'joints', 'lymphoid', 'muscles', 'nerves', 'organs', 'regions', 'skeleton', 'vessels'];
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Pure pack builder also used with temporary fixtures. No production metadata until data approval. */
export function buildPack(assetDir) {
  const catalogBytes = readFileSync(resolve(assetDir, 'parts-catalog.json'));
  const catalog = JSON.parse(catalogBytes);
  const systems = catalog.systems.map(({ id }) => id).sort();
  if (JSON.stringify(systems) !== JSON.stringify(SYSTEMS)) throw new Error('Expected all nine final catalog systems including lymphoid');
  const actual = readdirSync(resolve(assetDir, 'glb')).filter((name) => name.endsWith('.glb')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(SYSTEMS.map((id) => `${id}.glb`))) throw new Error('GLB set differs from final catalog');
  const paths = [...SYSTEMS.map((id) => `glb/${id}.glb`), 'parts-neighbors.json'];
  const archive = {};
  const assets = paths.map((path) => {
    const bytes = readFileSync(resolve(assetDir, path));
    if (!bytes.length) throw new Error(`Empty asset: ${path}`);
    archive[path] = [new Uint8Array(bytes), { mtime: new Date(2026, 9, 24, 0, 0, 0) }];
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const zip = zipSync(archive, { level: 9 });
  return { zip, metadata: {
    release: RELEASE, version: '0.1.8', pack: PACK_NAME,
    bytes: zip.length, sha256: sha256(zip), assets,
    publicObjects: [...assets, { path: 'parts-catalog.json', bytes: catalogBytes.length, sha256: sha256(catalogBytes) }],
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes('--assets-ready')) throw new Error('Wait for the data worker approval, then pass --assets-ready');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { zip, metadata } = buildPack(resolve(root, 'assets'));
  // Snapshot all source bytes before writing either release artifact.
  mkdirSync(resolve(root, 'release-assets'), { recursive: true });
  writeFileSync(resolve(root, 'release-assets', PACK_NAME), zip);
  writeFileSync(resolve(root, 'src/assetPack.generated.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify({ pack: PACK_NAME, bytes: zip.length, sha256: metadata.sha256, entries: metadata.assets.length }));
}
