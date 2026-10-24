# Reproducible anatomy data repair

This pipeline repairs selectable identities without replacing good geometry. It restores the ninth `lymphoid` system and 123 separately reviewed muscle/visceral source surfaces. Validation uses actual decoded vertex/index buffers through THREE.GLTFLoader and its Meshopt decoder.

## Inputs and preservation

- Original Z-Anatomy `Startup.blend` SHA-256: `9f08a17ea0115fed80b2a73ecdf0a1bc2ab2f6956f37c593ce23d513ea35afcd`.
- Source audit `inventory.json`, `mapping.json`, and `geometry/source-spatial-reconciliation.json`, produced by the MCP repository's `scripts/model-audit/` tools. Input hashes are pinned in generated provenance.
- Original eight GLBs are checked against the audit's SHA-256 values. Six remain byte-identical. Muscles/organs receive appended source meshes only: their original compressed binary chunk, node graph, meshes, accessors and buffer views remain exact prefixes. The unchanged nerve/vessel files preserve the original 0.5 mm treatment and tessellation.
- `baseline-catalog.json` is the immutable 3,540-row pre-repair catalog, retaining original display metadata for reproduction and omission review.
- Blender 5.2.3 LTS was used in background mode. The source `.blend` is never saved. Its checksum is verified before and after each source export/comparison.

## Run

Use absolute input/output paths. Preserve the original eight GLBs in a separate input directory before appending anything. Existing repository Node dependencies and Blender are sufficient.

```bash
# Lymphoid export, excluding Spleen and the two thymus lobes already in organs.
blender --background --disable-autoexec --python scripts/anatomy-data/export-lymphoid.py -- \
  /absolute/source/Startup.blend /absolute/source-audit/inventory.json /absolute/assets/glb

# Review evidence against ORIGINAL, not already-restored, muscles/organs GLBs.
node scripts/anatomy-data/prepare-surface-evidence.mjs /absolute/original-glbs /absolute/evidence
blender --background --disable-autoexec --python scripts/anatomy-data/compare-source-surfaces.py -- \
  /absolute/source/Startup.blend /absolute/source-audit/inventory.json \
  /absolute/geometry/source-spatial-reconciliation.json /absolute/evidence
node scripts/anatomy-data/decide-source-restoration.mjs \
  /absolute/evidence/source-surface-evidence.json /absolute/assets/source-restoration-decisions.json

# Export only the 123 explicitly reviewed missing source objects, then append.
blender --background --disable-autoexec --python scripts/anatomy-data/export-source-additions.py -- \
  /absolute/source/Startup.blend /absolute/source-audit/inventory.json \
  /absolute/assets/source-restoration-decisions.json /absolute/additions
node scripts/anatomy-data/append-source-additions.mjs \
  /absolute/original-glbs /absolute/additions /absolute/assets/glb
node scripts/anatomy-data/generate.mjs /absolute/source-audit /absolute/assets/glb \
  /absolute/assets /absolute/assets/source-restoration-decisions.json

node --test scripts/anatomy-data/geometry.test.mjs
node scripts/anatomy-data/validate.mjs /absolute/assets /absolute/assets/glb
node scripts/anatomy-data/verify-original-geometry.mjs /absolute/original-glbs /absolute/assets/glb
```

`lymphoid-export.json` and `source-additions-merged.json` in the GLB directory are build inputs, not runtime assets. Generation writes the catalog, neighbors, full provenance, and reviewed source decisions. Both repositories carry identical scripts and JSON outputs. Binary models remain local/ignored under existing repository policy and are included by the separate release-packaging pipeline.

Repeat generation and additive merging against the same inputs for byte-identical outputs. Generated JSON has no timestamps or machine paths. Blender binary reproducibility across versions is not promised.

## Identity and selection rules

1. Nerves and vessels use all positive finite source-named mesh nodes in their existing GLBs. Preserve exact display metadata. Transfer metadata for unique whitespace-only corrections, never guessed fuzzy aliases.
2. Other existing systems retain anatomical nodes, including named containers with positive mesh descendants. Only helper labels and targets without positive finite surfaces are removed.
3. The lymphoid collection has 163 eligible source objects. Spleen and both thymus lobes remain in `organs`; export only the other 160.
4. Each source export preserves the evaluated world matrix and glTF Y-up conversion `(x,y,z) -> (x,z,-y)`, without rescale/recenter. Check all 283 new objects against original source bounds within 0.01 mm.
5. Additional restoration is an explicit 125-case review, not an automatic nearest-bounds rule. All source objects retain one inclusion/exclusion/unresolved decision.

AABB means axis-aligned bounding box around transformed geometry. Neighbors use decoded world-space vertex AABBs, 30 nearest box separations in metres, four-decimal rounding and stable catalog-order ties. Insertions are excluded from both sources and candidates, preserving the legacy pipeline. Neighborhoods do not establish anatomical contact or surface distance.

## The 119 muscle and six visceral cases

`assets/source-restoration-decisions.json` retains measurements and rationale for **every one of these 125 cases**. Evidence compares every enabled source vertex and triangle centroid against the actual existing nonhelper triangle surfaces: 921,385 muscle triangles and 142,289 organ triangles. Nearest-surface measurements support the reviewed decisions but are not universal anatomical-equivalence criteria.

### Muscle decisions

Restore all 119 reviewed missing source objects:

- **78 bursae and 38 tendon sheaths** belong to exact original `Bursae`/`Tendon sheaths` collections. The legacy GLB has only helper-line collection labels, not their member anatomy. Across all 116, the 95th-percentile distance to any existing muscle-system surface is at least 0.803 mm and no more than 52.65% of samples lie within 0.3 mm. Adjacent muscles are not substitute bursa/sheath anatomy.
- **Two cruciform fibrous hand sheaths** are absent as named surfaces. Their nearest surfaces are flexor muscles and palmar aponeuroses. Each has a 95th-percentile surface separation of about 1.81 mm.
- **Transversalis fascia** is absent as a distinct surface. Its closest geometry is predominantly the transversus abdominis muscles, with 95th-percentile separation 7.88 mm. It is restored as its own original object rather than equated with adjacent muscle.

### Visceral decisions

| Source object | Decision | Surface evidence |
|---|---|---|
| Laryngopharynx | Restore original surface | 95th percentile 12.57 mm; 3.37% within 0.3 mm |
| Nasopharynx | Restore original surface | 25.81 mm; 0% within 0.3 mm |
| Oropharynx | Restore original surface | 11.23 mm; 10.74% within 0.3 mm |
| Mucosa of nasal cavity | Restore original surface | 38.53 mm; 0% within 0.3 mm |
| Medial basal segmental bronchus of right lung (BVII) | Existing renamed anatomical counterpart, no duplicate | Existing selectable `Medial basal segmental bronchus of right lung` is the nearest mesh for 97.02% of samples; 98.51% are within 1 mm of existing anatomy. Exact surface equivalence is not claimed. |
| Pleura | **Unresolved, do not duplicate** | 98.71% of samples lie within 2 mm of existing lung lobes. This cannot distinguish an omitted membrane from a merged or differently tessellated lung surface. |

The four restored visceral surfaces have no named counterparts. The legacy Pharynx group contains only a helper line, and the source surfaces differ substantially from the unrelated organ meshes nearby. The bronchus decision is a specific name-plus-surface review, not a bounds-only alias. Pleura remains explicitly unresolved.

## Acceptance results

| System | Selectable rows |
|---|---:|
| Skeleton | 271 |
| Muscles | 684 |
| Nerves | 582 |
| Vessels | 676 |
| Organs | 121 |
| Joints | 416 |
| Insertions | 728 |
| Regions | 256 |
| Lymphoid | 160 |
| **Total** | **3,894** |

- Every selectable row has a unique decoded target, finite positions/normals/matrices, valid indices and at least one positive-area triangle.
- All 1,258 nerve/vessel positive mesh nodes are selectable. The original exact-ID gap of 153 includes two whitespace corrections; the other 151 acquire new rows.
- All 3,540 original catalog decisions are retained: 3,458 unchanged, 2 whitespace corrections, 64 stale identities omitted, 10 no-surface targets omitted, 6 helper labels omitted.
- All 7,184 source decisions are conserved: 3,247 helper/type exclusions, 14 no-surface exclusions, 2,818 exact-name/descendant inclusions, 123 reviewed restorations, 1 reviewed renamed counterpart, **980 other unresolved identities plus unresolved Pleura**. Unresolved identities are not declared missing anatomy.
- Six original GLBs are byte-identical. The other two preserve original binary/graph prefixes. A separate decoded comparison verifies all **661 original muscle meshes and 311 original organ meshes**, including every attribute, index and world matrix, unchanged.
- Maximum source-bound errors: lymphoid `2.9499844567126843e-8` m; 123 additional objects `2.2269302596411578e-8` m.
- 94,980 neighbor edges across 3,166 source identities are recomputed during standalone validation, with no invalid, self or duplicate references.
- Seven focused tests cover named containers, world transforms, zero-area/nonfinite geometry, helper/empty targets, laterality, neighbor ordering/exclusions and additive-merge preservation/duplicate rejection. Full acceptance checks the real nine-system dataset.

Data checks do not establish clinical equivalence, visual quality or native-app behavior. Those remain separate renderer/coordinator acceptance concerns. The original source contains compatibility warnings in modern Blender; no source file is altered to silence them.
