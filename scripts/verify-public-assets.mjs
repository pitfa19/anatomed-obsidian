import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RELEASE, SYSTEMS, sha256 } from './package-assets.mjs';
export const PUBLIC_BASE = `https://uafyfwyyqzunabpuftue.supabase.co/storage/v1/object/public/models/${RELEASE}`;

export async function verifyPublicAssets(metadata, fetcher = fetch) {
  const expected = [...SYSTEMS.map((id) => `glb/${id}.glb`), 'parts-catalog.json', 'parts-neighbors.json'].sort();
  if (metadata.release !== RELEASE || JSON.stringify(metadata.publicObjects.map((entry) => entry.path).sort()) !== JSON.stringify(expected)) {
    throw new Error('Invalid release metadata');
  }
  for (const entry of metadata.publicObjects) {
    const response = await fetcher(`${PUBLIC_BASE}/${entry.path}`, { signal: AbortSignal.timeout(120_000), cache: 'no-store' });
    if (!response.ok) throw new Error(`Public asset unavailable: ${entry.path} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Public asset checksum mismatch: ${entry.path}`);
  }
  return metadata.publicObjects.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const metadata = JSON.parse(readFileSync(new URL('../src/assetPack.generated.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify({ release: RELEASE, publicObjectsVerified: await verifyPublicAssets(metadata) }));
}
