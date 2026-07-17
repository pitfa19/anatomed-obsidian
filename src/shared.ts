// Shared, runtime-free contract between the MCP server (region resolution) and
// the widget (rendering). Type-only — safe to import from both the Node server
// and the browser widget bundle.
import type { SystemId } from './vendor/types';

export interface RegionPart {
  id: string;
  name_en: string;
  name_lat: string;
  system: SystemId;
  side?: 'l' | 'r';
  /** True for surrounding-context structures auto-added at higher detail
   *  levels (rendered translucent, marked "ctx" in the legend). */
  context?: boolean;
}

/** How much surrounding context the view includes. */
export type RegionDetail = 'isolated' | 'related' | 'regional';

export interface RegionSystemMeta {
  id: SystemId;
  label_en: string;
  /** Hex tint applied to every mesh of this system. */
  tint: string;
  /** Path appended to assetBase to fetch the GLB, e.g. "glb/skeleton.glb". */
  glb: string;
}

/** The payload the tool returns (as structuredContent) and the widget renders.
 *  It describes a bounded REGION — a specific set of structures — never a whole
 *  system. The widget loads only the systems referenced here and isolates only
 *  these parts. */
export interface RegionPayload {
  schema: 'anatomed.region.v1';
  title: string;
  /** Absolute base URL the widget fetches GLBs from (Supabase public storage).
   *  Whitelisted via the resource's _meta.ui.csp.connectDomains. */
  assetBase: string;
  parts: RegionPart[];
  /** Only the systems present in `parts`, with tint + glb path. */
  systems: RegionSystemMeta[];
  /** How much context was included. */
  detail: RegionDetail;
  /** Queries that resolved to nothing (surfaced to the user). */
  unmatched: string[];
  /** Group aliases that expanded (e.g. "cervical spine" → 7 vertebrae). */
  expanded?: { query: string; label: string; count: number }[];
}

export const REGION_SCHEMA = 'anatomed.region.v1';
