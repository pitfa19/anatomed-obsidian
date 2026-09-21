import { readFileSync } from 'node:fs';
import { ASSETS, decodeAssetPack } from '../src/assetPack';

const pack = new Uint8Array(readFileSync('release-assets/anatomed-assets-v1.zip'));
const archive = decodeAssetPack(pack);
for (const [relative, expectedSize] of ASSETS) {
  if (archive[relative].byteLength !== expectedSize) throw new Error(`bad decoded size: ${relative}`);
}

const tampered = pack.slice();
tampered[Math.floor(tampered.length / 2)] ^= 1;
let rejected = false;
try {
  decodeAssetPack(tampered);
} catch (error) {
  rejected = String(error).includes('checksum mismatch');
}
if (!rejected) throw new Error('tampered asset pack was not rejected by checksum');

console.log(JSON.stringify({ decodedEntries: ASSETS.length, tamperedPackRejected: true }));
