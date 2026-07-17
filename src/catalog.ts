import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PartsCatalog, SystemId, SystemMeta } from './vendor/types';

// Resolved from CWD: project root locally, the Lambda task root on Vercel.
const CATALOG_PATH = resolve(process.cwd(), 'assets/parts-catalog.json');

let cache: PartsCatalog | null = null;

/** Load the committed parts catalog from disk (once). Drops Z-Anatomy
 *  top-level group containers (".g") exactly like the web app's loader. */
export function loadCatalog(): PartsCatalog {
  if (cache) return cache;
  const data = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as PartsCatalog;
  data.parts = data.parts.filter((p) => !p.id.endsWith('.g'));
  cache = data;
  return data;
}

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
