// Builds the Anatomed Obsidian plugin: bundles main.tsx -> main.js (CJS for
// Electron) and scopes+emits styles.css from the widget CSS. The neighbours
// dataset is NOT bundled — the plugin fetches it at runtime from the asset host
// (see ensureNeighbors in main.tsx). React/three/drei are bundled from
// devDependencies. Standalone: everything it needs is vendored in this repo.
import esbuild from 'esbuild';
import builtins from 'builtin-modules';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const prod = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';

// 1) Bundle the plugin JS.
await esbuild.build({
  entryPoints: [resolve(here, 'main.tsx')],
  outfile: resolve(here, 'main.js'),
  bundle: true,
  format: 'cjs',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.json': 'json' },
  external: ['obsidian', 'electron', ...builtins, ...builtins.map((b) => `node:${b}`)],
  define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
  sourcemap: prod ? false : 'inline',
  minify: prod,
  logLevel: 'info',
});

// 2) Emit styles.css from the widget CSS, SCOPED so it can't restyle the Obsidian
//    app itself. The widget assumes it owns the whole document (it runs in an
//    iframe); in a note we must confine the resets + variables to .am-root.
let css = readFileSync(resolve(here, 'widget/styles.css'), 'utf8');
const scope = [
  [':root {', '.am-root {'], // light-theme CSS variables -> scoped to the viewer root
  ['* { box-sizing: border-box; }', '.am-root, .am-root * { box-sizing: border-box; }'],
  [
    'html, body, #root { margin: 0; height: 100%; width: 100%; overscroll-behavior: none; }',
    '.am-root { overscroll-behavior: none; }',
  ],
  [
    'body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }',
    '.am-root { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }',
  ],
];
for (const [from, to] of scope) {
  if (!css.includes(from)) {
    throw new Error(
      `[anatomed] widget/styles.css changed: could not find global rule to scope:\n  ${from}\n` +
        `Update esbuild.config.mjs so global resets stay confined to .am-root.`,
    );
  }
  css = css.replace(from, to);
}
css +=
  '\n/* Obsidian embed helpers */\n' +
  '.am-embed-msg { color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem 0; }\n';
writeFileSync(resolve(here, 'styles.css'), css);

console.log(`[anatomed] obsidian plugin built (${prod ? 'prod' : 'dev'}).`);
