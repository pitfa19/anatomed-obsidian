import {
  EditorSuggest,
  type App,
  type Editor,
  type EditorPosition,
  type EditorSuggestContext,
  type EditorSuggestTriggerInfo,
  type TFile,
} from 'obsidian';
import { fuzzyMatchScored } from './src/vendor/fuzzy';
import { groupAliasSuggestions } from './src/vendor/resolveParts';
import type { PartsCatalog } from './src/vendor/types';

// Detail-level keywords (mirror RegionDetail in src/shared.ts) + short blurbs, so
// a `detail:` line inside an anatomed block also autocompletes.
const DETAILS = ['isolated', 'related', 'regional'] as const;
const DETAIL_NOTES: Record<(typeof DETAILS)[number], string> = {
  isolated: 'only the named structures',
  related: 'nearest neighbours (translucent)',
  regional: 'wider surrounding context',
};

type Kind = 'part' | 'group' | 'detail';

interface Candidate {
  /** The text inserted on select and matched by the fuzzy ranker. */
  term: string;
  kind: Kind;
  /** Muted secondary text shown on the right of the suggestion row. */
  note: string;
}

/** Strip the Blender duplicate suffix (".001") from a display name. */
const cleanName = (s: string): string => s.replace(/\.\d{3}$/, '');

/** Build the suggestion index once from the bundled catalogue: every unique
 *  English name + Latin synonym (where different) + the region-group aliases.
 *  Every candidate term is something `resolveQueryToParts` can resolve, so an
 *  inserted suggestion always renders. */
function buildCandidates(catalog: PartsCatalog): {
  terms: string[];
  byTerm: Map<string, Candidate>;
} {
  const sysLabel = new Map(catalog.systems.map((s) => [s.id, s.label_en]));
  const byTerm = new Map<string, Candidate>(); // key = lowercased term (dedupe)
  const add = (raw: string, cand: Candidate) => {
    const term = raw.trim();
    if (!term) return;
    const key = term.toLowerCase();
    if (!byTerm.has(key)) byTerm.set(key, cand);
  };

  for (const p of catalog.parts) {
    const en = cleanName(p.name_en);
    const lat = cleanName(p.name_lat);
    const sys = sysLabel.get(p.system) ?? p.system;
    add(en, { term: en, kind: 'part', note: lat && lat !== en ? `${lat} · ${sys}` : sys });
    if (lat && lat !== en) add(lat, { term: lat, kind: 'part', note: `${en} · ${sys}` });
  }
  for (const alias of groupAliasSuggestions()) {
    add(alias, { term: alias, kind: 'group', note: 'region group' });
  }

  const terms = [...byTerm.values()].map((c) => c.term);
  return { terms, byTerm };
}

/** Inline autocomplete for anatomical structures inside a fenced ```anatomed```
 *  block. Triggers on a `region:` / `parts:` value (per comma-separated segment),
 *  a bare query line, or a `detail:` value — mirroring main.tsx's parseBlock grammar. */
export class AnatomedSuggest extends EditorSuggest<Candidate> {
  private readonly terms: string[];
  private readonly byTerm: Map<string, Candidate>;
  // Set in onTrigger, read in getSuggestions (onTrigger always runs first).
  private mode: 'query' | 'detail' = 'query';

  constructor(app: App, catalog: PartsCatalog) {
    super(app);
    const { terms, byTerm } = buildCandidates(catalog);
    this.terms = terms;
    this.byTerm = byTerm;
    this.limit = 20;
  }

  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    _file: TFile | null,
  ): EditorSuggestTriggerInfo | null {
    if (!this.insideAnatomedBlock(editor, cursor.line)) return null;
    const upto = editor.getLine(cursor.line).slice(0, cursor.ch);

    // `detail:` value -> suggest isolated / related / regional.
    const detailM = upto.match(/^\s*detail\s*:\s*(.*)$/i);
    if (detailM) {
      this.mode = 'detail';
      const query = detailM[1].trimStart();
      return { start: { line: cursor.line, ch: cursor.ch - query.length }, end: cursor, query };
    }

    // `region:` / `parts:` value -> the comma-segment under the cursor; or a bare
    // query line (no colon, not a comment).
    let segment: string | null = null;
    const keyM = upto.match(/^\s*(?:regions?|parts?)\s*:\s*(.*)$/i);
    if (keyM) {
      const val = keyM[1];
      segment = val.slice(val.lastIndexOf(',') + 1);
    } else if (!upto.includes(':') && !upto.includes('#') && !upto.trimStart().startsWith('//')) {
      segment = upto;
    }
    if (segment === null) return null;

    const query = segment.trimStart();
    if (query.length < 1) return null;
    this.mode = 'query';
    return { start: { line: cursor.line, ch: cursor.ch - query.length }, end: cursor, query };
  }

  getSuggestions(ctx: EditorSuggestContext): Candidate[] {
    const q = ctx.query.trim();
    if (this.mode === 'detail') {
      const lc = q.toLowerCase();
      return DETAILS.filter((d) => d.startsWith(lc)).map((d) => ({
        term: d,
        kind: 'detail',
        note: DETAIL_NOTES[d],
      }));
    }
    if (!q) return [];
    const out: Candidate[] = [];
    for (const m of fuzzyMatchScored(q, this.terms, this.limit)) {
      const cand = this.byTerm.get(m.term.toLowerCase());
      if (cand) out.push(cand);
    }
    return out;
  }

  renderSuggestion(item: Candidate, el: HTMLElement): void {
    el.addClass('anatomed-suggest-item');
    el.createSpan({ cls: 'anatomed-suggest-name', text: item.term });
    if (item.note) el.createSpan({ cls: 'anatomed-suggest-note', text: item.note });
  }

  selectSuggestion(item: Candidate): void {
    const ctx = this.context;
    if (!ctx) return;
    ctx.editor.replaceRange(item.term, ctx.start, ctx.end);
    ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + item.term.length });
  }

  /** True when `line` sits inside a fenced ```anatomed``` block: scan upward to
   *  the nearest fence and require its info-string to be `anatomed` (a bare or
   *  differently-tagged fence, or a closing fence, means we're outside). */
  private insideAnatomedBlock(editor: Editor, line: number): boolean {
    for (let i = line; i >= 0; i--) {
      const fence = editor.getLine(i).match(/^\s*(?:`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/);
      if (fence) {
        if (i === line) return false; // cursor is on the fence line itself
        return fence[1].toLowerCase() === 'anatomed';
      }
    }
    return false;
  }
}
