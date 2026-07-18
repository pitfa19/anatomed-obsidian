// Vendored from anatomed-web/src/lib/viewer/resolveParts.ts.
// Group-alias + fuzzy resolution. Keep in sync with upstream when the group
// predicates change. Only the import lines differ from the original.
import { fuzzyMatchScored } from './fuzzy.js';
import type { Part, PartsCatalog } from './types';

interface CatalogIndex {
  terms: string[];
  byTerm: Map<string, Part[]>;
  groupCache: Map<string, Part[]>;
}

const CATALOG_INDEX = new WeakMap<PartsCatalog, CatalogIndex>();

/** Common queries whose obvious name doesn't exist verbatim in the catalog
 *  and whose fuzzy fallback would land on something semantically wrong. */
const ALIASES: Record<string, string> = {
  pelvis: 'Hip bone',
  'pelvic bone': 'Hip bone',
  'pelvic girdle': 'Hip bone',
  'os pelvis': 'Os coxae',
};

// ─── Group predicates ────────────────────────────────────────────────────────

const matchTarsus = (p: Part) =>
  p.system === 'skeleton' &&
  /^(Talus|Calcaneus|Navicular bone|Cuboid bone|Medial cuneiform bone|Intermediate cuneiform bone|Lateral cuneiform bone)$/.test(
    p.name_en,
  );

const matchMetatarsus = (p: Part) =>
  p.system === 'skeleton' &&
  /^(First|Second|Third|Fourth|Fifth) metatarsal bone$/.test(p.name_en);

const matchFootPhalanges = (p: Part) =>
  p.system === 'skeleton' &&
  /^(Proximal|Middle|Distal) phalanx of (first|second|third|fourth|fifth) finger of foot$/i.test(
    p.name_en,
  );

const matchFootBones = (p: Part) =>
  matchTarsus(p) ||
  matchMetatarsus(p) ||
  matchFootPhalanges(p) ||
  p.name_en === 'Sesamoid bones of foot';

const matchCarpus = (p: Part) =>
  p.system === 'skeleton' &&
  /^(Scaphoid|Lunate|Triquetrum|Pisiform|Trapezium|Trapezoid|Capitate|Hamate) bone$/.test(
    p.name_en,
  );

const matchMetacarpus = (p: Part) =>
  p.system === 'skeleton' &&
  /^(1st|2d|3d|4th|5th) metacarpal bone$/.test(p.name_en);

const matchHandPhalanges = (p: Part) =>
  p.system === 'skeleton' &&
  /^(Proximal|Middle|Distal) phalanx of (1st|2d|3rd|3d|4th|5th) finger$/.test(
    p.name_en,
  );

const matchHandBones = (p: Part) =>
  matchCarpus(p) || matchMetacarpus(p) || matchHandPhalanges(p);

const matchCervical = (p: Part) =>
  p.system === 'skeleton' &&
  (p.name_en === 'Atlas (C1)' ||
    p.name_en === 'Axis (C2).001' ||
    /^Vertebra C[3-7]$/.test(p.name_en));

const matchThoracic = (p: Part) =>
  p.system === 'skeleton' && /^Vertebra T(1[0-2]|[1-9])$/.test(p.name_en);

const matchLumbar = (p: Part) =>
  p.system === 'skeleton' && /^Vertebra L[1-5]$/.test(p.name_en);

const matchSpine = (p: Part) =>
  matchCervical(p) ||
  matchThoracic(p) ||
  matchLumbar(p) ||
  p.name_en === 'Sacrum' ||
  p.name_en === 'Coccyx';

const matchNeurocranium = (p: Part) =>
  p.system === 'skeleton' &&
  /^(Frontal|Parietal|Occipital|Temporal|Sphenoid|Ethmoid) bone$/.test(p.name_en);

const matchViscerocranium = (p: Part) =>
  p.system === 'skeleton' &&
  (p.name_en === 'Mandible' ||
    p.name_en === 'Maxilla' ||
    p.name_en === 'Vomer' ||
    /^(Zygomatic|Nasal|Lacrimal|Palatine|Inferior nasal concha) bone$/.test(
      p.name_en,
    ));

const matchSkullBones = (p: Part) =>
  matchNeurocranium(p) || matchViscerocranium(p) || p.name_en === 'Hyoid bone';

type GroupPredicate = (p: Part) => boolean;

interface GroupSpec {
  label: string;
  match: GroupPredicate;
}

const GROUP_SPECS: Record<string, GroupSpec> = {
  // Foot
  'foot bones': { label: 'Foot bones', match: matchFootBones },
  'bones of foot': { label: 'Foot bones', match: matchFootBones },
  'ossa pedis': { label: 'Foot bones', match: matchFootBones },
  tarsus: { label: 'Tarsus', match: matchTarsus },
  'ossa tarsi': { label: 'Tarsus', match: matchTarsus },
  metatarsus: { label: 'Metatarsus', match: matchMetatarsus },
  'ossa metatarsi': { label: 'Metatarsus', match: matchMetatarsus },
  'phalanges of foot': { label: 'Phalanges of foot', match: matchFootPhalanges },
  'phalanges pedis': { label: 'Phalanges of foot', match: matchFootPhalanges },

  // Hand
  'hand bones': { label: 'Hand bones', match: matchHandBones },
  'bones of hand': { label: 'Hand bones', match: matchHandBones },
  'ossa manus': { label: 'Hand bones', match: matchHandBones },
  carpus: { label: 'Carpus', match: matchCarpus },
  'carpal bones': { label: 'Carpus', match: matchCarpus },
  'ossa carpi': { label: 'Carpus', match: matchCarpus },
  metacarpus: { label: 'Metacarpus', match: matchMetacarpus },
  'ossa metacarpi': { label: 'Metacarpus', match: matchMetacarpus },
  'phalanges of hand': { label: 'Phalanges of hand', match: matchHandPhalanges },
  'phalanges manus': { label: 'Phalanges of hand', match: matchHandPhalanges },

  // Spine
  'cervical spine': { label: 'Cervical spine', match: matchCervical },
  'thoracic spine': { label: 'Thoracic spine', match: matchThoracic },
  'lumbar spine': { label: 'Lumbar spine', match: matchLumbar },
  spine: { label: 'Spine', match: matchSpine },
  'columna vertebralis': { label: 'Spine', match: matchSpine },

  // Skull
  neurocranium: { label: 'Neurocranium', match: matchNeurocranium },
  viscerocranium: { label: 'Viscerocranium', match: matchViscerocranium },
  'facial skeleton': { label: 'Viscerocranium', match: matchViscerocranium },
  'skull bones': { label: 'Skull bones', match: matchSkullBones },
  'ossa cranii': { label: 'Skull bones', match: matchSkullBones },
};

function buildIndex(catalog: PartsCatalog): CatalogIndex {
  const cached = CATALOG_INDEX.get(catalog);
  if (cached) return cached;
  const byTerm = new Map<string, Part[]>();
  const terms: string[] = [];
  const seenTerms = new Set<string>();
  const push = (term: string, part: Part) => {
    const trimmed = term?.trim();
    if (!trimmed) return;
    const lc = trimmed.toLowerCase();
    let bucket = byTerm.get(lc);
    if (!bucket) {
      bucket = [];
      byTerm.set(lc, bucket);
    }
    bucket.push(part);
    if (!seenTerms.has(trimmed)) {
      seenTerms.add(trimmed);
      terms.push(trimmed);
    }
  };
  for (const p of catalog.parts) {
    push(p.name_en, p);
    if (p.name_lat) push(p.name_lat, p);
  }
  const idx = { terms, byTerm, groupCache: new Map<string, Part[]>() };
  CATALOG_INDEX.set(catalog, idx);
  return idx;
}

function preferRight(parts: Part[]): Part {
  for (const p of parts) if (p.side === 'r') return p;
  return parts[0];
}

/** Run a group predicate against the catalog, side-deduping (one Part per
 *  unique name_en, preferring the right-side mirror). Cached per-catalog. */
function expandGroup(catalog: PartsCatalog, spec: GroupSpec): Part[] {
  const idx = buildIndex(catalog);
  const cached = idx.groupCache.get(spec.label);
  if (cached) return cached;
  const byName = new Map<string, Part[]>();
  for (const p of catalog.parts) {
    if (!spec.match(p)) continue;
    let bucket = byName.get(p.name_en);
    if (!bucket) {
      bucket = [];
      byName.set(p.name_en, bucket);
    }
    bucket.push(p);
  }
  const out: Part[] = [];
  for (const bucket of byName.values()) out.push(preferRight(bucket));
  idx.groupCache.set(spec.label, out);
  return out;
}

const FUZZY_THRESHOLD = 0.5;

export function resolvePartByQuery(
  catalog: PartsCatalog,
  query: string,
): Part | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const lc = trimmed.toLowerCase();
  const idx = buildIndex(catalog);

  const aliased = ALIASES[lc];
  if (aliased) {
    const bucket = idx.byTerm.get(aliased.toLowerCase());
    if (bucket && bucket.length > 0) return preferRight(bucket);
  }

  const exact = idx.byTerm.get(lc);
  if (exact && exact.length > 0) return preferRight(exact);

  const scored = fuzzyMatchScored(trimmed, idx.terms, 5);
  for (const m of scored) {
    if (m.score < FUZZY_THRESHOLD) break;
    const bucket = idx.byTerm.get(m.term.toLowerCase());
    if (bucket && bucket.length > 0) return preferRight(bucket);
  }
  return null;
}

export interface ResolvedQuery {
  parts: Part[];
  expanded?: { label: string; count: number };
}

/** Resolve a single user-facing query string to one or more catalog parts.
 *  Group aliases return the full group; single structures return a one-element
 *  array. Returns `null` only when nothing matched. */
export function resolveQueryToParts(
  catalog: PartsCatalog,
  query: string,
): ResolvedQuery | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const lc = trimmed.toLowerCase();

  const groupSpec = GROUP_SPECS[lc];
  if (groupSpec) {
    const parts = expandGroup(catalog, groupSpec);
    if (parts.length > 0) {
      return { parts, expanded: { label: groupSpec.label, count: parts.length } };
    }
  }

  const single = resolvePartByQuery(catalog, trimmed);
  if (single) return { parts: [single] };
  return null;
}

/** All group alias phrases (for tool docs / discoverability). */
export function knownGroupAliases(): string[] {
  return Object.keys(GROUP_SPECS);
}

/** One clean English suggestion per group (deduped by label) for autocomplete UIs.
 *  GROUP_SPECS is bilingual (English + Latin keys) with several groups aliased
 *  more than once; the `label` is always the English display name and
 *  lowercase(label) is itself a valid key, so suggesting labels keeps every
 *  suggestion resolvable while dropping Latin/duplicate keys. */
export function groupAliasSuggestions(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const spec of Object.values(GROUP_SPECS)) {
    if (!seen.has(spec.label)) {
      seen.add(spec.label);
      out.push(spec.label);
    }
  }
  return out;
}
