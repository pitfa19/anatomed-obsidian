import {
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownRenderChild,
  normalizePath,
  requestUrl,
  TFile,
  Notice,
  type App,
  type MarkdownPostProcessorContext,
  type SettingDefinitionItem,
} from 'obsidian';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildRegion } from './src/region';
import { primeNeighbors } from './src/neighbors';
import type { RegionDetail, RegionPart, RegionPayload } from './src/shared';
import type { PartsCatalog } from './src/vendor/types';
import RegionViewer from './widget/RegionViewer';
import { AnatomedSuggest } from './suggest';
import catalogRaw from './assets/parts-catalog.json';

// Bundled, validated catalogue (Z-Anatomy-derived). Drop the ".g" group
// containers exactly like the server's loadCatalog does.
const CATALOG: PartsCatalog = (() => {
  const raw = catalogRaw as unknown as PartsCatalog;
  return { ...raw, parts: raw.parts.filter((p) => !p.id.endsWith('.g')) };
})();

const SUPABASE_ASSETS =
  'https://uafyfwyyqzunabpuftue.supabase.co/storage/v1/object/public/models';

const DETAILS: RegionDetail[] = ['isolated', 'related', 'regional'];

interface AnatomedSettings {
  assetBase: string;
  notesFolder: string;
  height: number;
  defaultDetail: RegionDetail;
}
const DEFAULT_SETTINGS: AnatomedSettings = {
  assetBase: SUPABASE_ASSETS,
  notesFolder: '',
  height: 480,
  defaultDetail: 'isolated',
};

interface BlockConfig {
  queries: string[];
  detail: RegionDetail;
  title?: string;
}

/** Parse a fenced ```anatomed block. `region:`/`parts:` lines (comma-separated)
 *  become queries; a bare line is also a query; `detail:` and `title:` tune the
 *  view. Lines starting with # or // are comments. */
function parseBlock(source: string, defaultDetail: RegionDetail): BlockConfig {
  const queries: string[] = [];
  let detail = defaultDetail;
  let title: string | undefined;
  for (const line of source.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    const i = t.indexOf(':');
    if (i === -1) {
      queries.push(t);
      continue;
    }
    const key = t.slice(0, i).trim().toLowerCase();
    const val = t.slice(i + 1).trim();
    if (key === 'region' || key === 'regions' || key === 'part' || key === 'parts') {
      for (const q of val.split(',').map((s) => s.trim()).filter(Boolean)) queries.push(q);
    } else if (key === 'detail') {
      if ((DETAILS as string[]).includes(val)) detail = val as RegionDetail;
    } else if (key === 'title') {
      title = val;
    } else {
      queries.push(t);
    }
  }
  return { queries, detail, title };
}

function AnatomedEmbed({
  payload,
  onSelect,
  onChange,
  catalog,
  ensureNeighbors,
}: {
  payload: RegionPayload;
  onSelect: (p: RegionPart) => void;
  onChange: (spec: { parts: string[]; detail: RegionDetail }) => void;
  catalog: PartsCatalog;
  ensureNeighbors: () => Promise<void>;
}) {
  const unmatched = payload.unmatched.length ? ` · ${payload.unmatched.length} unmatched` : '';
  const n = payload.parts.length;
  return (
    <>
      <div className="am-header">
        <span className="am-title">{payload.title}</span>
        <span className="am-sub">
          {n} structure{n === 1 ? '' : 's'}
          {unmatched}
        </span>
      </div>
      <RegionViewer
        payload={payload}
        onSelect={onSelect}
        selectHint="Make a note about this structure"
        onChange={onChange}
        catalog={catalog}
        ensureNeighbors={ensureNeighbors}
      />
    </>
  );
}

/** Render a normalized ```anatomed``` block for persistence. Round-trips through
 *  parseBlock (parts + detail [+ title]), so the re-render it triggers yields the
 *  same spec and can't loop. */
function renderAnatomedBlock(
  spec: { parts: string[]; detail: RegionDetail },
  title?: string,
): string {
  const lines = ['```anatomed', `parts: ${spec.parts.join(', ')}`, `detail: ${spec.detail}`];
  if (title) lines.push(`title: ${title}`);
  lines.push('```');
  return lines.join('\n');
}

/** Replace the inclusive line range [start, end] of `data` with `replacement`. */
function spliceLines(data: string, start: number, end: number, replacement: string): string {
  const lines = data.split('\n');
  lines.splice(start, end - start + 1, ...replacement.split('\n'));
  return lines.join('\n');
}

export default class AnatomedPlugin extends Plugin {
  settings: AnatomedSettings = DEFAULT_SETTINGS;
  private neighborsReady: Promise<void> | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AnatomedSettingTab(this.app, this));
    this.registerMarkdownCodeBlockProcessor('anatomed', (source, el, ctx) =>
      this.render(source, el, ctx),
    );
    // Inline autocomplete for structure names inside an ```anatomed``` block.
    this.registerEditorSuggest(new AnatomedSuggest(this.app, CATALOG));
  }

  /** Lazily fetch + prime the neighbours dataset (only needed for related/regional).
   *  Streamed from the asset host (same origin as the GLBs) rather than bundled, so
   *  the shipped plugin stays small and has no filesystem dependency. `requestUrl`
   *  is Obsidian's fetch that isn't subject to CORS. */
  private ensureNeighbors(): Promise<void> {
    if (!this.neighborsReady) {
      this.neighborsReady = (async () => {
        const url = `${this.settings.assetBase}/parts-neighbors.json`;
        const res = await requestUrl({ url });
        // requestUrl().json is typed `any`; type it to primeNeighbors' param.
        primeNeighbors(res.json as Parameters<typeof primeNeighbors>[0]);
      })().catch((e) => {
        this.neighborsReady = null; // allow a later retry
        throw e;
      });
    }
    return this.neighborsReady;
  }

  private async render(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const cfg = parseBlock(source, this.settings.defaultDetail);
    if (!cfg.queries.length) {
      el.createDiv({
        cls: 'am-embed-msg',
        text: 'anatomed: add a `region:` or `parts:` line, e.g. `region: cervical spine`.',
      });
      return;
    }

    if (cfg.detail !== 'isolated') {
      try {
        await this.ensureNeighbors();
      } catch (e) {
        console.warn('[anatomed] neighbours unavailable, falling back to isolated', e);
        new Notice('Anatomed: context data unavailable, showing isolated view.');
        cfg.detail = 'isolated';
      }
    }

    const { payload } = buildRegion(CATALOG, cfg.queries, this.settings.assetBase, {
      detail: cfg.detail,
      title: cfg.title,
    });

    const root = el.createDiv({ cls: 'am-root' });
    if (document.body.classList.contains('theme-dark')) root.addClass('am-dark');
    root.style.height = `${this.settings.height}px`;

    const persist = this.makeBlockPersister(el, ctx, cfg.title);
    const reactRoot = createRoot(root);
    reactRoot.render(
      <StrictMode>
        <AnatomedEmbed
          payload={payload}
          onSelect={(p) => void this.openOrCreateNote(p)}
          onChange={persist}
          catalog={CATALOG}
          ensureNeighbors={() => this.ensureNeighbors()}
        />
      </StrictMode>,
    );
    // Unmount (disposing the WebGL context) when the block leaves the DOM.
    ctx.addChild(new ReactChild(root, reactRoot));
  }

  /** A debounced persister that rewrites the ```anatomed``` block this viewer came
   *  from when the user edits it in-widget (add / remove / change detail). Uses the
   *  section-info line range + an atomic vault.process; the written block round-trips
   *  through parseBlock, so the re-render it triggers doesn't loop. */
  private makeBlockPersister(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    title?: string,
  ): (spec: { parts: string[]; detail: RegionDetail }) => void {
    let timer: number | null = null;
    let latest: { parts: string[]; detail: RegionDetail } | null = null;
    const flush = async () => {
      timer = null;
      const spec = latest;
      latest = null;
      if (!spec) return;
      const info = ctx.getSectionInfo(el);
      if (!info) return; // block not in the render cache (e.g. already re-rendered)
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!(file instanceof TFile)) return;
      const block = renderAnatomedBlock(spec, title);
      try {
        await this.app.vault.process(file, (data) =>
          spliceLines(data, info.lineStart, info.lineEnd, block),
        );
      } catch (e) {
        console.warn('[anatomed] could not persist block edit', e);
      }
    };
    return (spec) => {
      latest = spec;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void flush(), 600);
    };
  }

  /** Click a structure -> open (or create) its note, wiring the viewer into the
   *  student's knowledge map. */
  private async openOrCreateNote(part: RegionPart) {
    const safe = part.name_en.replace(/[\\/:*?"<>|#^[\]]/g, '').trim();
    if (!safe) return;
    const folder = this.settings.notesFolder.trim().replace(/^\/+|\/+$/g, '');
    const path = normalizePath(folder ? `${folder}/${safe}.md` : `${safe}.md`);

    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
        try {
          await this.app.vault.createFolder(folder);
        } catch {
          /* already exists */
        }
      }
      const lat =
        part.name_lat && part.name_lat !== part.name_en ? ` (*${part.name_lat}*)` : '';
      try {
        file = await this.app.vault.create(path, `# ${part.name_en}${lat}\n\n`);
      } catch {
        file = this.app.vault.getAbstractFileByPath(path); // lost a create race
      }
    }
    if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<AnatomedSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class ReactChild extends MarkdownRenderChild {
  constructor(
    el: HTMLElement,
    private root: Root,
  ) {
    super(el);
  }
  onunload() {
    this.root.unmount();
  }
}

class AnatomedSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: AnatomedPlugin,
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Asset base URL')
      .setDesc('Base URL the 3D models (GLB files) are fetched from.')
      .addText((t) =>
        t
          .setPlaceholder(SUPABASE_ASSETS)
          .setValue(this.plugin.settings.assetBase)
          .onChange(async (v) => {
            this.plugin.settings.assetBase = (v.trim() || SUPABASE_ASSETS).replace(/\/+$/, '');
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Structure notes folder')
      .setDesc('Folder for notes created when you click a structure (blank = vault root).')
      .addText((t) =>
        t
          .setPlaceholder('Anatomy')
          .setValue(this.plugin.settings.notesFolder)
          .onChange(async (v) => {
            this.plugin.settings.notesFolder = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Viewer height (px)')
      .setDesc('Height of each embedded viewer (200–1200).')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.height)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 200 && n <= 1200) {
            this.plugin.settings.height = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName('Default detail')
      .setDesc('Context level used when a block omits `detail:`.')
      .addDropdown((d) =>
        d
          .addOptions({ isolated: 'isolated', related: 'related', regional: 'regional' })
          .setValue(this.plugin.settings.defaultDetail)
          .onChange(async (v) => {
            this.plugin.settings.defaultDetail = v as RegionDetail;
            await this.plugin.saveSettings();
          }),
      );
  }

  /** Declarative mirror of display() so the settings are indexed by Obsidian's
   *  settings search on 1.13.0+ (display() above still renders them, incl. on
   *  older versions). setControlValue() persists + normalizes edits the
   *  framework makes through this definition path. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: 'Asset base URL',
        desc: 'Base URL the 3D models (GLB files) are fetched from.',
        control: { type: 'text', key: 'assetBase', placeholder: SUPABASE_ASSETS },
      },
      {
        name: 'Structure notes folder',
        desc: 'Folder for notes created when you click a structure (blank = vault root).',
        control: { type: 'text', key: 'notesFolder', placeholder: 'Anatomy' },
      },
      {
        name: 'Viewer height (px)',
        desc: 'Height of each embedded viewer (200–1200).',
        control: {
          type: 'number',
          key: 'height',
          min: 200,
          max: 1200,
          validate: (v) => (v >= 200 && v <= 1200 ? undefined : 'Enter a height between 200 and 1200.'),
        },
      },
      {
        name: 'Default detail',
        desc: 'Context level used when a block omits `detail:`.',
        control: {
          type: 'dropdown',
          key: 'defaultDetail',
          options: { isolated: 'isolated', related: 'related', regional: 'regional' },
        },
      },
    ];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    switch (key) {
      case 'assetBase':
        s.assetBase = (String(value).trim() || SUPABASE_ASSETS).replace(/\/+$/, '');
        break;
      case 'notesFolder':
        s.notesFolder = String(value);
        break;
      case 'height':
        s.height = value as number;
        break;
      case 'defaultDetail':
        s.defaultDetail = value as RegionDetail;
        break;
      default:
        return;
    }
    await this.plugin.saveSettings();
  }
}
