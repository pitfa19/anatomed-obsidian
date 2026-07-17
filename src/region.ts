import type { PartsCatalog } from './vendor/types';
import { resolveQueryToParts } from './vendor/resolveParts.js';
import { getSystem } from './catalog.js';
import { contextFor } from './neighbors.js';
import {
  REGION_SCHEMA,
  type RegionDetail,
  type RegionPart,
  type RegionPayload,
  type RegionSystemMeta,
} from './shared.js';

/** Hard cap on focus structures. Enforces the product rule: always a bounded
 *  REGION, never the whole model. */
export const MAX_REGION_PARTS = 60;

/** Per-detail-level context tuning: how many nearest neighbours to pull per
 *  focus part, and the total context cap. */
const DETAIL_TUNING: Record<RegionDetail, { perPart: number; cap: number }> = {
  isolated: { perPart: 0, cap: 0 },
  related: { perPart: 6, cap: 14 },
  regional: { perPart: 14, cap: 30 },
};

export interface BuildRegionResult {
  payload: RegionPayload;
  summary: string;
}

export interface BuildRegionOptions {
  title?: string;
  detail?: RegionDetail;
}

/** Resolve queries into a bounded RegionPayload, optionally adding surrounding
 *  context structures (nearest neighbours) at higher detail levels. */
export function buildRegion(
  catalog: PartsCatalog,
  queries: string[],
  assetBase: string,
  opts: BuildRegionOptions = {},
): BuildRegionResult {
  const detail: RegionDetail = opts.detail ?? 'isolated';
  const parts: RegionPart[] = [];
  const seen = new Set<string>();
  const unmatched: string[] = [];
  const expanded: NonNullable<RegionPayload['expanded']> = [];
  let truncated = false;

  for (const raw of queries) {
    const query = (raw ?? '').trim();
    if (!query) continue;
    const resolved = resolveQueryToParts(catalog, query);
    if (!resolved) {
      unmatched.push(query);
      continue;
    }
    if (resolved.expanded) {
      expanded.push({ query, label: resolved.expanded.label, count: resolved.expanded.count });
    }
    for (const p of resolved.parts) {
      if (seen.has(p.id)) continue;
      if (parts.length >= MAX_REGION_PARTS) {
        truncated = true;
        break;
      }
      seen.add(p.id);
      parts.push({
        id: p.id, // raw id — must match the GLB node name
        name_en: cleanName(p.name_en),
        name_lat: cleanName(p.name_lat),
        system: p.system,
        side: p.side,
      });
    }
    if (truncated) break;
  }

  // Surrounding context (structures the focus parts pass through / near).
  const focusIds = parts.map((p) => p.id);
  const tuning = DETAIL_TUNING[detail];
  let contextCount = 0;
  if (tuning.perPart > 0 && focusIds.length > 0) {
    const ctx = contextFor(catalog, focusIds, tuning.perPart, tuning.cap);
    for (const p of ctx) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      parts.push({
        id: p.id,
        name_en: cleanName(p.name_en),
        name_lat: cleanName(p.name_lat),
        system: p.system,
        side: p.side,
        context: true,
      });
      contextCount++;
    }
  }

  const sysIds = [...new Set(parts.map((p) => p.system))];
  const systems: RegionSystemMeta[] = sysIds.map((id) => {
    const s = getSystem(catalog, id);
    return {
      id,
      label_en: s?.label_en ?? id,
      tint: s?.tint ?? '#cccccc',
      glb: `glb/${id}.glb`,
    };
  });

  const focusParts = parts.filter((p) => !p.context);
  const resolvedTitle = opts.title?.trim() || deriveTitle(focusParts, expanded);

  const payload: RegionPayload = {
    schema: REGION_SCHEMA,
    title: resolvedTitle,
    assetBase,
    parts,
    systems,
    detail,
    unmatched,
    expanded: expanded.length ? expanded : undefined,
  };

  const summary = buildSummary(payload, focusParts.length, contextCount, truncated);
  return { payload, summary };
}

/** Strip the trailing Blender duplicate suffix (".001") from a display name. */
function cleanName(name: string): string {
  return name.replace(/\.\d{3}$/, '');
}

function deriveTitle(
  focusParts: RegionPart[],
  expanded: NonNullable<RegionPayload['expanded']>,
): string {
  if (expanded.length === 1 && focusParts.length > 1) return expanded[0]!.label;
  if (focusParts.length === 0) return 'Anatomy';
  const names = [...new Set(focusParts.map((p) => p.name_en))];
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
}

function buildSummary(
  payload: RegionPayload,
  focusCount: number,
  contextCount: number,
  truncated: boolean,
): string {
  const focusNames = [...new Set(payload.parts.filter((p) => !p.context).map((p) => p.name_en))];
  const lines: string[] = [];
  if (focusCount === 0) {
    lines.push('No matching anatomical structures were found.');
  } else {
    lines.push(`Rendering an interactive 3D view of ${focusNames.join(', ')}.`);
  }
  if (contextCount > 0) {
    const ctxNames = [...new Set(payload.parts.filter((p) => p.context).map((p) => p.name_en))];
    lines.push(`Surrounding context (${payload.detail}, shown translucent): ${ctxNames.join(', ')}.`);
  }
  if (payload.unmatched.length) lines.push(`Not found: ${payload.unmatched.join(', ')}.`);
  if (truncated) lines.push(`Focus capped at ${MAX_REGION_PARTS} structures.`);
  return lines.join(' ');
}
