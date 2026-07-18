import type { Part, PartsCatalog, SystemId } from './vendor/types';
import { getPartIndex } from './catalog.js';

// NOTE: browser (Obsidian-plugin) copy of the anatomed-mcp module. It drops the
// server's disk-based neighbour loader: the plugin fetches parts-neighbors.json at
// runtime and seeds it via primeNeighbors(), so this build never reads from disk.

interface Neighbor {
  id: string;
  system: SystemId;
  dist: number;
}
type NeighborMap = Record<string, Neighbor[]>;

let cache: NeighborMap | null = null;

/** Seed the neighbour map directly instead of reading it from disk. The plugin
 *  ships parts-neighbors.json as a runtime-fetched asset and primes it here, so
 *  `contextFor` never reads from disk. */
export function primeNeighbors(map: NeighborMap): void {
  cache = map;
}

/** Surrounding-context structures for a set of focus parts: the nearest
 *  precomputed neighbours (by AABB-to-AABB distance) across all systems —
 *  i.e. the structures each focus part passes through / runs near. Ranked by
 *  closest-to-any-focus, de-duped, excluding the focus set, capped.
 *  Returns [] if the neighbour map hasn't been primed yet. */
export function contextFor(
  catalog: PartsCatalog,
  focusIds: string[],
  perPart: number,
  cap: number,
): Part[] {
  const neighbors = cache ?? {};
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
