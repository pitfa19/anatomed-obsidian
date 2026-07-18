// Builds the Anatomed Obsidian plugin: bundles main.tsx -> main.js (CJS for
// Electron) and scopes+emits styles.css from the widget CSS. The neighbours
// dataset is NOT bundled — the plugin fetches it at runtime from the asset host
// (see ensureNeighbors in main.tsx). React/three/drei are bundled from
// devDependencies. Standalone: everything it needs is vendored in this repo.
import esbuild from 'esbuild';
import { builtinModules as builtins } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const prod = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';

// Neutralize react-dom's dead <script>-hoisting code. React 19's DOM client builds
// executable <script> nodes two ways in its resource/preinit ("Float") machinery:
// `createElement("script")` and a `div.innerHTML = "<script></script>"` trick — used
// ONLY when an app renders a <script> element or calls ReactDOM.preinit / preload. This
// plugin does neither, so both paths are unreachable — but Obsidian's automated review
// flags the mere PRESENCE of dynamic <script> creation as a policy violation. We rewrite
// both to an inert <template> in the (dead) react-dom source, so the shipped bundle
// contains no dynamic <script> creation. Guarded PER pattern: if react-dom changes the
// number of sites, the build fails loudly so we re-verify rather than silently shipping.
const neutralizeReactDomScriptHoisting = {
  name: 'neutralize-reactdom-script-hoisting',
  setup(build) {
    build.onLoad(
      { filter: /react-dom[\\/]cjs[\\/]react-dom-client\.(production|development)\.js$/ },
      (args) => {
        let src = readFileSync(args.path, 'utf8');
        const patch = (needle, repl, want) => {
          const found = src.split(needle).length - 1;
          if (found !== want) {
            throw new Error(
              `[anatomed] expected ${want}x \`${needle}\` in ${args.path}, found ${found}. ` +
                `react-dom changed — re-verify the <script>-hoisting neutralization before shipping.`,
            );
          }
          src = src.split(needle).join(repl);
        };
        patch('createElement("script")', 'createElement("template")', 3);
        patch('"<script>\\x3c/script>"', '"<template>\\x3c/template>"', 1);
        return { contents: src, loader: 'js' };
      },
    );
  },
};

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
  plugins: [neutralizeReactDomScriptHoisting],
  sourcemap: prod ? false : 'inline',
  minify: prod,
  logLevel: 'info',
});

// Safety net for the neutralization above: the shipped bundle must contain NO dynamic
// <script> creation (Obsidian's "code obfuscation" review rejects it). Fail the build
// loudly if any token leaks through, rather than shipping a bundle that gets flagged.
{
  const bundle = readFileSync(resolve(here, 'main.js'), 'utf8');
  const forbidden = ['createElement("script")', "createElement('script')", '<script'];
  const leaks = forbidden.filter((tok) => bundle.includes(tok));
  if (leaks.length) {
    throw new Error(
      `[anatomed] main.js contains dynamic <script> creation tokens: ${leaks.join(', ')}. ` +
        `The react-dom <script>-hoisting neutralization is incomplete — re-verify before shipping.`,
    );
  }
}

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
    'body { font-family: var(--font-interface, sans-serif); }',
    '.am-root { font-family: var(--font-interface, sans-serif); }',
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
  '.am-embed-msg { color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem 0; }\n' +
  '/* Structure autocomplete (EditorSuggest popup; rendered outside .am-root) */\n' +
  '.anatomed-suggest-item { display: flex; align-items: baseline; gap: 0.75em; }\n' +
  '.anatomed-suggest-note { margin-left: auto; color: var(--text-muted); font-size: 0.82em; white-space: nowrap; }\n';
writeFileSync(resolve(here, 'styles.css'), css);

console.log(`[anatomed] obsidian plugin built (${prod ? 'prod' : 'dev'}).`);
