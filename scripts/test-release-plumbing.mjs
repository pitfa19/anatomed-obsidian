import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, stat, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { buildPack, SYSTEMS, RELEASE, VERSION, PACK_NAME } from './package-assets.mjs';
import { verifyPublicAssets, PUBLIC_BASE } from './verify-public-assets.mjs';

const dir = await mkdtemp(join(process.env.JCODE_SCRATCH_DIR || tmpdir(), 'anatomed-release-test-'));
try {
  const source = join(dir, 'source');
  await mkdir(join(source, 'glb'), { recursive: true });
  for (const id of SYSTEMS) await writeFile(join(source, `glb/${id}.glb`), `fixture:${id}`);
  await writeFile(join(source, 'parts-neighbors.json'), '{"fixture":true}');
  await writeFile(join(source, 'parts-catalog.json'), JSON.stringify({ systems: SYSTEMS.map((id) => ({ id })) }));
  const { zip, metadata } = buildPack(source);
  assert.deepEqual(buildPack(source), { zip, metadata }, 'pack generation is deterministic');
  for (const TZ of ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { buildPack } from ${JSON.stringify(new URL('./package-assets.mjs', import.meta.url).href)}; console.log(buildPack(${JSON.stringify(source)}).metadata.sha256);`,
    ], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), metadata.sha256, `deterministic ZIP in ${TZ}`);
  }
  assert.equal(metadata.assets.length, 10);
  const releaseDir = join(dir, 'release');
  await mkdir(join(releaseDir, 'src'), { recursive: true });
  await mkdir(join(releaseDir, 'assets'), { recursive: true });
  await mkdir(join(releaseDir, 'release-assets'), { recursive: true });
  await writeFile(join(releaseDir, 'src/assetPack.generated.json'), JSON.stringify(metadata));
  await writeFile(join(releaseDir, `release-assets/${PACK_NAME}`), zip);
  await writeFile(join(releaseDir, 'assets/parts-catalog.json'), await readFile(join(source, 'parts-catalog.json')));
  await writeFile(join(releaseDir, 'manifest.json'), JSON.stringify({ version: VERSION, minAppVersion: '1.5.0' }));
  await writeFile(join(releaseDir, 'package.json'), JSON.stringify({ version: VERSION }));
  await writeFile(join(releaseDir, 'package-lock.json'), JSON.stringify({ version: VERSION, packages: { '': { version: VERSION } } }));
  await writeFile(join(releaseDir, 'versions.json'), JSON.stringify({ '0.1.8': '1.5.0', [VERSION]: '1.5.0' }));
  assert.equal(VERSION, '0.1.9');
  assert.equal(PACK_NAME, 'anatomed-assets-v3.zip');
  assert.equal(RELEASE, 'releases/2026-10-24-v3');
  const verifyRelease = () => spawnSync(process.execPath, [fileURLToPath(new URL('./verify-release.mjs', import.meta.url))], { cwd: releaseDir, encoding: 'utf8' });
  const goodRelease = verifyRelease();
  assert.equal(goodRelease.status, 0, goodRelease.stderr);
  await writeFile(join(releaseDir, 'assets/parts-neighbors.json'), 'changed since packaging');
  assert.notEqual(verifyRelease().status, 0, 'source drift blocks release verification');
  await rm(join(releaseDir, 'assets/parts-neighbors.json'));
  await writeFile(join(releaseDir, 'package.json'), JSON.stringify({ version: '0.1.8' }));
  assert.notEqual(verifyRelease().status, 0, 'version drift blocks release verification');
  await writeFile(join(source, 'glb/extra.glb'), 'extra');
  assert.throws(() => buildPack(source), /GLB set differs/);
  await rm(join(source, 'glb/extra.glb'));

  const outfile = join(dir, 'runtime.mjs');
  await build({
    stdin: { contents: "export * from './src/localAssets'; export * from './src/assetPack';", resolveDir: process.cwd(), loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    plugins: [{ name: 'temporary-fixtures', setup(builder) {
      builder.onResolve({ filter: /assetPack\.generated\.json$/ }, () => ({ path: 'metadata', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: JSON.stringify(metadata), loader: 'json' }));
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const normalizePath = p => p; export const requestUrl = (...args) => globalThis.fixtureRequest(...args);' }));
    } }],
  });
  const runtime = await import(pathToFileURL(outfile).href);
  assert.ok(runtime.DEFAULT_ASSET_BASE.endsWith('/releases/2026-10-24-v3'));
  assert.equal(runtime.migrateAssetBase(runtime.LEGACY_ASSET_BASE), runtime.DEFAULT_ASSET_BASE);
  assert.equal(runtime.migrateAssetBase(runtime.LEGACY_ASSET_BASE + '/'), runtime.DEFAULT_ASSET_BASE);
  const v2Default = runtime.LEGACY_ASSET_BASE + '/releases/2026-10-24-v2';
  assert.equal(runtime.migrateAssetBase(v2Default), runtime.DEFAULT_ASSET_BASE, 'v2 default upgrades');
  assert.equal(runtime.migrateAssetBase(v2Default + '/'), runtime.DEFAULT_ASSET_BASE, 'v2 default with slash upgrades');
  assert.equal(runtime.migrateAssetBase(runtime.DEFAULT_ASSET_BASE), runtime.DEFAULT_ASSET_BASE);
  assert.equal(runtime.migrateAssetBase('https://custom.invalid/a/'), 'https://custom.invalid/a/');
  const oldVersion = runtime.LEGACY_ASSET_BASE + '/releases/older';
  assert.equal(runtime.migrateAssetBase(oldVersion), oldVersion);
  const archive = runtime.decodeAssetPack(zip);
  assert.equal(Object.keys(archive).length, 10);
  const corrupted = zip.slice(); corrupted[30] ^= 1;
  assert.throws(() => runtime.decodeAssetPack(corrupted), /checksum mismatch/);

  const vault = join(dir, 'vault');
  const ab = (bytes) => new Uint8Array(bytes).slice().buffer;
  const adapter = {
    exists: async (p) => access(join(vault, p)).then(() => true, () => false),
    stat: async (p) => stat(join(vault, p)),
    mkdir: async (p) => mkdir(join(vault, p), { recursive: true }),
    readBinary: async (p) => ab(await readFile(join(vault, p))),
    writeBinary: async (p, bytes) => writeFile(join(vault, p), new Uint8Array(bytes)),
    getResourcePath: (p) => `app://vault/${p}?mtime=123`,
  };
  const legacy = '.obsidian/plugins/anatomed/assets/glb/skeleton.glb';
  await mkdir(join(vault, '.obsidian/plugins/anatomed/assets/glb'), { recursive: true });
  await writeFile(join(vault, legacy), 'legacy rollback sentinel');
  const app = { vault: { configDir: '.obsidian', adapter } };
  const plugin = { manifest: { id: 'anatomed' } };
  const store = new runtime.LocalAssetStore(app, plugin, () => runtime.DEFAULT_ASSET_BASE);
  const requests = [];
  globalThis.fixtureRequest = async ({ url }) => {
    requests.push(url);
    if (url === runtime.ASSET_PACK_URL) return { arrayBuffer: ab(zip) };
    return { arrayBuffer: ab(archive[url.split(`${RELEASE}/`)[1]]) };
  };
  assert.equal(await store.isReady(), false);
  const one = store.prepare();
  assert.equal(one, store.prepare(undefined, true), 'active download is shared');
  assert.equal(await one, `app://vault/.obsidian/plugins/anatomed/assets/${RELEASE}`);
  assert.equal(await store.isReady(), true);
  assert.equal(requests.length, 1, 'one pack download');
  assert.equal(await readFile(join(vault, legacy), 'utf8'), 'legacy rollback sentinel');
  await store.prepare();
  assert.equal(requests.length, 1, 'warm cache is offline');
  const skeleton = join(vault, `.obsidian/plugins/anatomed/assets/${RELEASE}/glb/skeleton.glb`);
  const wrong = Buffer.from(archive['glb/skeleton.glb']); wrong[0] ^= 1;
  await writeFile(skeleton, wrong);
  assert.equal(await store.isReady(), false, 'same-size corruption is stale');
  await store.prepare();
  assert.equal(await store.isReady(), true);
  assert.equal(requests.length, 2, 'stale cache repaired');

  await writeFile(skeleton, wrong);
  requests.length = 0;
  const custom = new runtime.LocalAssetStore(app, plugin, () => 'https://custom.invalid/mirror/');
  globalThis.fixtureRequest = async ({ url }) => {
    requests.push(url);
    assert.ok(url.startsWith('https://custom.invalid/mirror/'));
    return { arrayBuffer: ab(archive[url.split('/mirror/')[1]]) };
  };
  await custom.prepare();
  assert.deepEqual(requests, ['https://custom.invalid/mirror/glb/skeleton.glb']);
  await writeFile(skeleton, wrong);
  globalThis.fixtureRequest = async () => ({ arrayBuffer: ab(wrong) });
  await assert.rejects(custom.prepare(), /asset content mismatch/);
  assert.equal(await custom.isReady(), false);
  // Invalid pack falls back to the immutable default URL, never the old root.
  globalThis.fixtureRequest = async ({ url }) => {
    if (url === runtime.ASSET_PACK_URL) throw new Error('fixture offline pack');
    assert.ok(url.startsWith(runtime.DEFAULT_ASSET_BASE + '/'));
    return { arrayBuffer: ab(archive[url.split(`${RELEASE}/`)[1]]) };
  };
  await store.prepare();
  assert.equal(await store.isReady(), true);
  assert.deepEqual(await store.readJson('parts-neighbors.json'), { fixture: true });
  const publicFetch = async (url) => new Response(await readFile(join(source, url.slice(PUBLIC_BASE.length + 1))));
  assert.equal(await verifyPublicAssets(metadata, publicFetch), 11);
  await assert.rejects(verifyPublicAssets({ ...metadata, publicObjects: metadata.publicObjects.slice(1) }, publicFetch), /Invalid release metadata/);
  await assert.rejects(verifyPublicAssets(metadata, async () => new Response('bad')), /checksum mismatch/);
  await assert.rejects(verifyPublicAssets(metadata, async () => new Response('', { status: 404 })), /unavailable/);
  console.log('PASS: deterministic nine-system fixture pack, tampering, settings migration, cache repair/rollback, custom URL, fallback, public publication gate');
} finally {
  delete globalThis.fixtureRequest;
  await rm(dir, { recursive: true, force: true });
}
