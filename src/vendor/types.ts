// Vendored from anatomed-web/src/lib/viewer/types.ts (pure subset, no three.js).
// Keep in sync if the upstream catalog schema changes.

export type SystemId =
  | 'skeleton'
  | 'muscles'
  | 'nerves'
  | 'vessels'
  | 'organs'
  | 'joints'
  | 'insertions'
  | 'regions';

export interface SystemMeta {
  id: SystemId;
  label_en: string;
  label_hr: string;
  glb: string;
  tint: string;
}

export interface Part {
  id: string;
  system: SystemId;
  name_en: string;
  name_lat: string;
  side?: 'l' | 'r';
}

export interface PartsCatalog {
  systems: SystemMeta[];
  parts: Part[];
}
