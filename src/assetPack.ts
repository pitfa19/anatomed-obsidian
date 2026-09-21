import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

export const ASSET_PACK_URL =
  'https://github.com/pitfa19/anatomed-obsidian/releases/download/0.1.7/anatomed-assets-v1.zip';
export const ASSET_PACK_SHA256 =
  'd4e3662e1d391e8e4ce798fbddcaaa6eba17c6770bc2b0c69ca27609d8a3e9a5';

export const ASSETS = [
  ['glb/insertions.glb', 1_383_896],
  ['glb/joints.glb', 1_140_768],
  ['glb/muscles.glb', 2_971_584],
  ['glb/nerves.glb', 5_835_352],
  ['glb/organs.glb', 1_386_016],
  ['glb/regions.glb', 752_024],
  ['glb/skeleton.glb', 1_873_564],
  ['glb/vessels.glb', 5_692_308],
  ['parts-neighbors.json', 5_960_668],
] as const;

export type AssetPath = (typeof ASSETS)[number][0];

export function decodeAssetPack(input: ArrayBuffer | Uint8Array): Record<AssetPath, Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== ASSET_PACK_SHA256) {
    throw new Error(`asset pack checksum mismatch: expected ${ASSET_PACK_SHA256}, received ${digest}`);
  }

  const archive = unzipSync(bytes);
  const expected = new Set<string>(ASSETS.map(([relative]) => relative));
  const extras = Object.keys(archive).filter((relative) => !expected.has(relative));
  if (extras.length > 0) throw new Error(`unexpected asset pack entries: ${extras.join(', ')}`);

  for (const [relative, expectedSize] of ASSETS) {
    const file = archive[relative];
    if (!file || file.byteLength !== expectedSize) {
      throw new Error(`asset pack entry mismatch for ${relative}`);
    }
  }
  return archive as Record<AssetPath, Uint8Array>;
}
