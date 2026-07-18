import type { PartsCatalog, SystemId, SystemMeta } from './vendor/types';

// NOTE: browser (Obsidian-plugin) copy of the anatomed-mcp module. It intentionally
// drops the server's disk-based catalog loader: the plugin bundles parts-catalog.json
// and injects it directly (see main.tsx), so nothing here ever reads from disk.

export function getSystem(catalog: PartsCatalog, id: SystemId): SystemMeta | null {
  return catalog.systems.find((s) => s.id === id) ?? null;
}

let partIndex: Map<string, import('./vendor/types').Part> | null = null;

/** id → Part lookup (cached). */
export function getPartIndex(catalog: PartsCatalog): Map<string, import('./vendor/types').Part> {
  if (partIndex) return partIndex;
  const m = new Map<string, import('./vendor/types').Part>();
  for (const p of catalog.parts) m.set(p.id, p);
  partIndex = m;
  return m;
}
