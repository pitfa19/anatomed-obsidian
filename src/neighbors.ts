import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Part, PartsCatalog, SystemId } from './vendor/types';
import { getPartIndex } from './catalog.js';

interface Neighbor {
  id: string;
  system: SystemId;
  dist: number;
}
type NeighborMap = Record<string, Neighbor[]>;

// Resolved from CWD: project root locally, the Lambda task root on Vercel.
const NEIGHBORS_PATH = resolve(process.cwd(), 'assets/parts-neighbors.json');

let cache: NeighborMap | null = null;

function loadNeighbors(): NeighborMap {
  if (cache) return cache;
  cache = JSON.parse(readFileSync(NEIGHBORS_PATH, 'utf8')) as NeighborMap;
  return cache;
}

/** Seed the neighbour map directly instead of reading it from disk. Used by
 *  browser hosts (e.g. the Obsidian plugin) that ship parts-neighbors.json as a
 *  bundled/sidecar asset, so `contextFor` never touches `fs`. The Node server
 *  keeps using `loadNeighbors` unchanged. */
export function primeNeighbors(map: NeighborMap): void {
  cache = map;
}

/** Surrounding-context structures for a set of focus parts: the nearest
 *  precomputed neighbours (by AABB-to-AABB distance) across all systems —
 *  i.e. the structures each focus part passes through / runs near. Ranked by
 *  closest-to-any-focus, de-duped, excluding the focus set, capped. */
export function contextFor(
  catalog: PartsCatalog,
  focusIds: string[],
  perPart: number,
  cap: number,
): Part[] {
  const neighbors = loadNeighbors();
  const index = getPartIndex(catalog);
  const focus = new Set(focusIds);

  // neighbour id → best (smallest) rank across all focus parts
  const bestRank = new Map<string, number>();
  for (const fid of focusIds) {
    const list = neighbors[fid];
    if (!list) continue;
    const take = list.slice(0, perPart);
    take.forEach((n, rank) => {
      if (focus.has(n.id)) return;
      const prev = bestRank.get(n.id);
      if (prev === undefined || rank < prev) bestRank.set(n.id, rank);
    });
  }

  const ranked = [...bestRank.entries()].sort((a, b) => a[1] - b[1]);
  const out: Part[] = [];
  for (const [id] of ranked) {
    const part = index.get(id);
    if (!part) continue; // not in catalog (e.g. degenerate/".g")
    out.push(part);
    if (out.length >= cap) break;
  }
  return out;
}
