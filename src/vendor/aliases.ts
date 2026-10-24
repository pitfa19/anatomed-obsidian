// Reviewed name changes from the 2026-10-24 source/export audit. These are
// lexical aliases, not geometry-based guesses of anatomical equivalence.
export const LEGACY_NAMES: Record<string, string> = {
  'hyppoglossal nerve (xii)': 'Hypoglossal nerve (XII)',
  'ophtalmic nerve': 'Ophthalmic nerve',
  'accessory nucleus of oculomotor nucleus': 'Accessory nucleus of oculomotor nerve',
  'aqueduct of midbrain (cerebral aqueduct)': 'Aqueduct of midbrain',
  'communicating branch of median nerve with ulnar nerve': '(Communicating branch of median nerve with ulnar nerve)',
  'zonular fibers-curve': 'Zonular fibres',
  'posterior interosseus artery': 'Posterior interosseous artery',
  'recurrent interosseus artery': 'Recurrent interosseous artery',
  'superior ophtalmic vein': 'Superior ophthalmic vein',
  'supra-orbital arter': 'Supra-orbital artery',
  'occiptal sinus': 'Occipital sinus',
  'left ascending lumbal vein': 'Left ascending lumbar vein',
};

export const LEGACY_IDS: Record<string, string> = {
  'hypothalamus.r': 'Hypothalamus',
  'spinal dura.001': 'Spinal dura',
  'common plantar digital branches of medial plantar nerve.001': 'Common plantar digital branches of medial plantar nerve',
};

// Exact membership of the source Cerebellum collection, not a substring match:
// excludes cerebellar vessels, nuclei and unrelated structures.
export const CEREBELLUM_IDS = new Set([
  ...[
    'Anterior quadrangular lobule', 'Base of peduncle', 'Biventral lobule',
    'Flocculus', 'Gracile lobule', 'Inferior semilunar lobule',
    'Peduncle of flocculus', 'Posterior quadrangular lobule',
    'Superior cerebellar peduncle', 'Superior semilunar lobule',
    'Tonsil of cerebellum', 'Wing of central lobule',
  ].flatMap((name) => [`${name}.l`, `${name}.r`]),
  'Central lobule', 'Culmen', 'Declive', 'Folium of vermis',
  'Lingula of cerebellum', 'Nodule of vermis', 'Pyramis of vermis',
  'Tuber of vermis', 'Uvula of vermis',
].map((id) => id.toLowerCase()));
