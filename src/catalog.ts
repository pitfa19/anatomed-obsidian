import type { PartsCatalog, SystemId, SystemMeta } from './vendor/types';

// Pure, browser-safe catalog helpers. The disk-based loader (loadCatalog) lives in the
// Node-only assets-node.ts (server); browser hosts (the widget, the Obsidian plugin)
// inject or fetch the catalog and call these helpers. Nothing here reads from disk.

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
