# Anatomed: 3D Anatomy for Obsidian

Embed interactive, **region-isolated 3D anatomy** directly in your notes. Write an `anatomed`
code block and get a live, rotatable 3D model inline, showing only the structures you asked
for, with a legend to toggle each one. Click a structure to open (or create) its note, wiring
anatomy into your knowledge map.

The models are a validated, Z-Anatomy-derived catalogue of ~3,500 named structures. Rendering is
always a bounded *region* (never a whole body system), with graded context: `isolated` /
`related` / `regional`.

## Demo

[![Anatomed: 3D anatomy rendered inline in an Obsidian note](docs/obsidian-demo-poster.png)](https://uafyfwyyqzunabpuftue.supabase.co/storage/v1/object/public/models/media/obsidian-demo.mp4)

Write an `anatomed` block, get a live 3D model inline, toggle structures, and click one to open
its note. Click the image to play.

## Install

**From the community catalogue** (once approved): Settings → Community plugins → **Browse** →
search **"Anatomed 3D Anatomy"** → Install → Enable.

**Manually:** download `manifest.json`, `main.js`, and `styles.css` from the
[latest release](https://github.com/pitfa19/anatomed-obsidian/releases/latest) into
`<your-vault>/.obsidian/plugins/anatomed/`, then enable the plugin in Settings → Community
plugins. Desktop only for now.

## Usage

Add a fenced `anatomed` code block to any note:

````markdown
```anatomed
region: cervical spine
detail: related
title: Cervical spine
```
````

- `region:` / `parts:` accept one or more structures (comma-separated), in English or Latin.
- `detail:` accepts `isolated` (default), `related`, or `regional` (surrounding structures shown translucent).
- `title:` sets an optional heading.

Drag to rotate, scroll to zoom, right-drag to pan; toggle structures in the legend; hover for
names. **Click a structure** to open (or create) a `[[Structure]]` note.

## Settings

- **Asset base URL**: where the 3D models (and the `related`/`regional` context data) are fetched from.
- **Structure notes folder**: where click-to-create notes are placed.
- **Viewer height** and **Default detail**.

## Privacy & network

The 3D model files (GLB), plus a nearest-neighbour dataset used only for `related`/`regional` blocks,
stream from a public asset host (configurable above). Nothing else leaves your machine; there is
no telemetry.

## Building from source

This repository is self-contained (MIT). The viewer core under `src/` and `widget/` is shared with
the sibling project **[anatomed-mcp](https://github.com/pitfa19/anatomed-mcp)** (which renders the
same anatomy inline in Claude).

```bash
git clone https://github.com/pitfa19/anatomed-obsidian
cd anatomed-obsidian && npm install
npm run build            # -> main.js, styles.css   (npm run dev for an unminified build)
```

Layout: `main.tsx` (plugin entry) · `src/` (region resolver + catalogue) · `widget/` (R3F viewer
+ helpers) · `assets/parts-catalog.json` (bundled catalogue). The GLB models and the
`related`/`regional` neighbour data are fetched at runtime from the asset host.

## License & attribution

- **Software** (this plugin's code): [MIT](LICENSE).
- **3D anatomy models + derived data**: **CC BY-SA 4.0** (see [`LICENSE-ASSETS`](LICENSE-ASSETS)
  and [`NOTICE`](NOTICE)). Derived from **[Z-Anatomy](https://www.z-anatomy.com/)** (Kervyn &
  Zielinski, CC BY-SA 4.0), itself derived from **BodyParts3D** (DBCLS, CC BY-SA 2.1 Japan).
  Attribution is required.
