# 0.1.8 immutable asset release

Release identity: `releases/2026-10-24-v2`. Plugin archive: `anatomed-assets-v2.zip`.
The nine systems include lymphoid. The ZIP contains the nine GLBs and neighbors JSON.
The generated metadata also records the catalog checksum so the public host, MCP,
bundled Obsidian catalog, and local pack can be checked against the same bytes.

## Preparation, without publication

Do not generate checksums until the data worker confirms final synchronized assets.
No install is needed on the prepared workstation. Package scripts are unchanged.

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

The final command is a read-only dry run. It checks every local file against approved
metadata, checks public object existence and content, and prints missing paths.
Commit `src/assetPack.generated.json` and `release-assets/anatomed-assets-v2.zip`
together with the final catalog and release code. Retain the v1 ZIP.
`verify:release` fails if source files changed after packaging. CI can verify the
committed pack even without gitignored raw GLBs.

## Coordinator-only publication, after approval

The worker must not run these commands. Use the existing Supabase service-role key
in the environment, never a command-line literal or committed file. No bucket creation
or settings changes are performed by the upload script.

```bash
cd /Users/fabijanpitlovic/Documents/anatomed-mcp
npm run upload:assets -- --manifest /Users/fabijanpitlovic/Documents/anatomed-obsidian/src/assetPack.generated.json --upload
npm run upload:assets -- --manifest /Users/fabijanpitlovic/Documents/anatomed-obsidian/src/assetPack.generated.json --verify-only

cd /Users/fabijanpitlovic/Documents/anatomed-obsidian
npm run verify:release
node scripts/verify-public-assets.mjs
```

Upload creates missing objects only (`x-upsert: false`). Identical existing objects
are skipped, so interrupted uploads can resume. Any content conflict aborts the whole
preflight before writes. A race during creation fails rather than overwriting.
A differing object requires a new release prefix and new matching code/metadata,
not deletion or overwrite. Public readback hashes every object after uploading.

**Assets first, applications second:** only after both public verifiers pass may the
coordinator push/deploy MCP and tag/push Obsidian. Ensure an existing MCP
`ASSET_BASE_URL` environment override does not still point at the legacy root.
The new built-in default is the versioned prefix. Keep intentional custom overrides.

With all approved commits already committed, the coordinator may run:

```bash
cd /Users/fabijanpitlovic/Documents/anatomed-mcp
git push origin main
# Deploy using the existing approved Vercel workflow/tooling, not a new install.

cd /Users/fabijanpitlovic/Documents/anatomed-obsidian
git push origin main
git tag 0.1.8
git push origin 0.1.8
```

The tag workflow verifies local pack integrity, bootstrap, fixture behavior, and all
11 publicly hosted objects before attesting artifacts or creating the GitHub release.
It attaches `main.js`, `manifest.json`, `styles.css`, and `anatomed-assets-v2.zip`.
The workflow does not upload to Supabase or need its credentials.

## Cache migration and rollback

New local caches live under `assets/releases/2026-10-24-v2` inside the plugin folder.
Readiness checks both byte length and SHA-256, detecting same-size stale content.
The old `assets/glb` and old neighbors file are neither deleted nor overwritten.
Concurrent preparation shares one download. A failed or partial write cannot become
ready until all files verify. Pack failure falls back to the same immutable hosted
release. Custom base URLs are preserved and used directly, not silently replaced by
the GitHub pack. A custom mirror must serve the approved release bytes.

Only an exact old built-in root URL (ignoring trailing slashes) migrates automatically.
Other custom or deliberately versioned URLs remain unchanged.

Rollback MCP to its previous deployment and previous asset base. Rollback Obsidian by
reinstalling release 0.1.7, whose v1 ZIP and old cache remain available. If using remote
mode, restore its old built-in root URL as well. Do not repoint old release objects or
delete the new release during rollback. New data must never be paired with an old
catalog merely by switching an asset URL in the new plugin.
