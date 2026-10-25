# 0.1.9 immutable asset release

Release identity: `releases/2026-10-24-v3`. Plugin archive: `anatomed-assets-v3.zip`.
Same immutable-release model as [0.1.8](release-0.1.8.md): nine system GLBs plus
neighbors JSON in the ZIP, catalog checksum recorded in the generated metadata.

## What changed in the data

- 19 restored Z-Anatomy structures:
  - 8 left-side muscle attachment patches, including 2 that replace wrong-side duplicates
    (for example `Abductor hallucis on medial process of calcaneal tuberosity.l`).
  - 2 trochanteric insertion patches (`Trochanteric insertion.l/.r`).
  - 6 ethmoid air cells (for example `Anterior cells of ethmoid bone.l`).
  - `Hairs of head`, `Mucosa of stomach`, `Pleura`.
- Laterality fixes for `Lateral temporomandibular ligament` and `Eyelashes`
  (`left eyelashes` resolves to exactly `Eyelashes.l`).
- Catalog: 3,911 parts.

MCP acceptance (`scripts/model-audit/check-repair-acceptance.mjs`) covers the new
structures and the eyelash laterality case, and asserts the v3 asset base.

## Preparation, without publication

Do not generate checksums until the data worker confirms final synchronized assets.
The version and pack name come from one place: `VERSION`, `RELEASE` and `PACK_NAME`
in `scripts/package-assets.mjs`, which `verify-release.mjs` and the plumbing test import.

```bash
cd /Users/fabijanpitlovic/Documents/anatomed-obsidian
node scripts/package-assets.mjs --assets-ready
node scripts/test-release-plumbing.mjs
/Users/fabijanpitlovic/Documents/anatomed-mcp/node_modules/.bin/tsx --test test/*.test.ts
npm run typecheck
npm run verify:release
npm run verify:bootstrap
npm run build

cd /Users/fabijanpitlovic/Documents/anatomed-mcp
node_modules/.bin/tsx --test test/upload-assets.test.ts
npm run typecheck
npm run upload:assets -- --manifest /Users/fabijanpitlovic/Documents/anatomed-obsidian/src/assetPack.generated.json
```

The last command is a read-only dry run. Commit `src/assetPack.generated.json` and
`release-assets/anatomed-assets-v3.zip` together with the final catalog and release code.
Retain the v1 and v2 ZIPs in `release-assets/`.

## Coordinator-only publication, after approval

Identical to 0.1.8 with the new identity: upload with `--upload`, then `--verify-only`,
then `npm run verify:release` and `node scripts/verify-public-assets.mjs` in Obsidian.
Upload never overwrites (`x-upsert: false`). A differing object needs a new prefix.

**Assets first, applications second.** Only after both public verifiers pass:

```bash
cd /Users/fabijanpitlovic/Documents/anatomed-mcp
git push origin main
# Deploy with the existing approved Vercel workflow.

cd /Users/fabijanpitlovic/Documents/anatomed-obsidian
git push origin main
git tag 0.1.9
git push origin 0.1.9
```

Check that no MCP `ASSET_BASE_URL` override still points at the v2 prefix or the root.
The tag workflow attests and attaches `main.js`, `manifest.json`, `styles.css` and
`anatomed-assets-v3.zip`.

## Settings migration (v2 to v3)

0.1.8 persisted its built-in default (`.../models/releases/2026-10-24-v2`) into
`data.json`. `migrateAssetBase` now upgrades two exact values, trailing slashes ignored,
to the v3 default:

- the legacy root `.../storage/v1/object/public/models`
- the previous built-in default `.../models/releases/2026-10-24-v2`

Any other custom or versioned URL (for example `.../models/releases/older`) is kept.
`scripts/test-release-plumbing.mjs` asserts all of these cases.

New caches live under `assets/releases/2026-10-24-v3`. The v2 cache is not deleted.

## Rollback

Rollback MCP to its previous deployment (v2 asset base). Rollback Obsidian by reinstalling
0.1.8: its v2 ZIP, hosted v2 objects and v2 cache remain. If a user had a custom v2 URL,
it was never rewritten except for the exact old default. Do not repoint or delete v2 or v3
objects. Never pair new data with an old catalog by only switching an asset URL.
