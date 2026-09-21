import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratchRoot = process.env.JCODE_SCRATCH_DIR || tmpdir();
const dir = await mkdtemp(join(scratchRoot, 'anatomed-bootstrap-'));
const outfile = join(dir, 'verify-bootstrap.mjs');
try {
  await build({
    entryPoints: ['scripts/verify-bootstrap.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
