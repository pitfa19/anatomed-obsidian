# Renderer regression tests

Run the focused helper tests using Node with native TypeScript support (validated with Node 26):

```sh
node --test test/renderer.test.ts
```

MCP also runs these through its existing `npm test` command. No browser or assets are needed for helper tests. They cover landscape/portrait fitting, multiple initial orientations, orbiting without a refit, depth planes, degenerate bounds, invalid inputs, two-sided focus/context materials, unchanged thin tubes including lymphoid, intentional insertion-marker thinning, and visibility isolation.

## Actual viewer regression (from anatomed-mcp)

The MCP repository's `test/renderer-browser.mjs` runs both repositories' actual RegionViewer implementations through the existing observation-only audit harness. It selects the baseline's 15 valid blank surfaces and all framing warnings, renders three views at 800x400 and 360x720, and asserts all selected cases pass. It does not alter baseline scripts or artifacts.

Start the existing harness with an explicit **new** output directory, using `scripts/model-audit/viewer/server.mjs --mcp-assets <asset-parent> --output <new-output> --port 8771`, then run:

```sh
node test/renderer-browser.mjs <baseline-audit-directory> <new-output> http://127.0.0.1:8771
node test/renderer-evidence.mjs <baseline-audit-directory> <new-output>
```

This requires the locally installed headless Chrome used by `scripts/model-audit/run-browser.mjs`. Set `AUDIT_CHROME` to override its executable. No packages are installed or remote services used. Exact GLB paths and checksums are recorded by the harness. A selected-case regression is not an exhaustive catalog audit or an Obsidian/MCP-host/device acceptance check.

The camera deliberately reserves a bounding sphere so ordinary rotation cannot clip the fitted selection. This is more conservative than a tight fit of the initial projection, especially for depth-aligned shapes. User pan/zoom remains untouched until an existing refit trigger (selection, viewport resize, or recenter).

## Restored source surfaces

After the 123 reviewed missing surfaces are integrated, decode every actual GLB with the production loader/decoder and run the real tint helper:

```sh
node test/renderer-source-geometry.mjs <absolute-repository-root> <new-evidence-json>
```

This checks all 123 restored identities have finite triangle geometry and identical before/after world bounds. Every mesh in all nine systems is checked for scale, world-matrix and world-bounds changes. The only permitted rescaling is the existing 122 intentional insertion markers. It records exact GLB hashes for the checked bytes. Optional final argument `observe` writes diagnostic evidence without enforcing the unchanged-geometry assertions. This is a geometry/transform integration test, not a pixel-render test.
