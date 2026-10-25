import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import metadata from './assetPack.generated.json';

export const ASSET_RELEASE = 'releases/2026-10-24-v3';
/** Built-in default shipped by 0.1.8; saved in users' data.json and upgraded on load. */
export const PREVIOUS_DEFAULT_ASSET_BASE =
  'https://uafyfwyyqzunabpuftue.supabase.co/storage/v1/object/public/models/releases/2026-10-24-v2';
export const LEGACY_ASSET_BASE = 'https://uafyfwyyqzunabpuftue.supabase.co/storage/v1/object/public/models';
export const DEFAULT_ASSET_BASE = `${LEGACY_ASSET_BASE}/${ASSET_RELEASE}`;
export const ASSET_PACK_URL =
  'https://github.com/pitfa19/anatomed-obsidian/releases/download/0.1.9/anatomed-assets-v3.zip';
export const ASSET_PACK_SHA256 = metadata.sha256;
export const ASSETS: ReadonlyArray<readonly [string, number, string]> = metadata.assets.map(
  (asset) => [asset.path, asset.bytes, asset.sha256] as const,
);
export type AssetPath = string;

/** Upgrade only old built-in defaults (legacy root, 0.1.8 v2). Deliberate custom/rollback URLs survive. */
export function migrateAssetBase(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed === LEGACY_ASSET_BASE || trimmed === PREVIOUS_DEFAULT_ASSET_BASE ? DEFAULT_ASSET_BASE : base;
}

export function assetDigest(input: ArrayBuffer | Uint8Array): string {
  return createHash('sha256').update(input instanceof Uint8Array ? input : new Uint8Array(input)).digest('hex');
}

export function assertAsset(relative: string, input: ArrayBuffer | Uint8Array): void {
  const expected = ASSETS.find(([path]) => path === relative);
  if (!expected || input.byteLength !== expected[1] || assetDigest(input) !== expected[2]) {
    throw new Error(`asset content mismatch for ${relative}`);
  }
}

export function decodeAssetPack(input: ArrayBuffer | Uint8Array): Record<AssetPath, Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = assetDigest(bytes);
  if (metadata.release !== ASSET_RELEASE || !ASSETS.length || digest !== ASSET_PACK_SHA256) {
    throw new Error(`asset pack checksum mismatch: expected ${ASSET_PACK_SHA256}, received ${digest}`);
  }
  const archive = unzipSync(bytes);
  const expected = new Set(ASSETS.map(([relative]) => relative));
  const extras = Object.keys(archive).filter((relative) => !expected.has(relative));
  if (extras.length > 0) throw new Error(`unexpected asset pack entries: ${extras.join(', ')}`);
  for (const [relative] of ASSETS) {
    if (!archive[relative]) throw new Error(`missing asset pack entry: ${relative}`);
    assertAsset(relative, archive[relative]);
  }
  return archive;
}
