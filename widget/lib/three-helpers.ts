// Trimmed, vendored three.js helpers from anatomed-web's viewer
// (isolate.ts + fit.ts + InlineAnatomy3D tint/thin). Region-only: no labels,
// no connector lines, no neighbours.
import * as THREE from 'three';
import type { SystemId } from '../../src/vendor/types';

const LIN_TOKEN = '-lin';
const LABELS_TOKEN = 'labels';

export function sanitizeNodeName(name: string): string {
  return THREE.PropertyBinding.sanitizeNodeName(name);
}

export function findPartByName(root: THREE.Object3D, id: string): THREE.Object3D | null {
  const target = sanitizeNodeName(id);
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && o.name === target) found = o;
  });
  return found;
}

/** Show exactly the meshes belonging to `partIds` (and their ancestor chain);
 *  hide everything else, including connector-line meshes. Always hides first,
 *  so toggling a part off cleanly removes it. */
export function setVisibleParts(root: THREE.Object3D, partIds: string[]): void {
  const targetSet = new Set<THREE.Object3D>();
  const roots: THREE.Object3D[] = [];
  for (const id of partIds) {
    const t = findPartByName(root, id);
    if (!t) continue;
    roots.push(t);
    t.traverse((o) => targetSet.add(o));
  }
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const isConnector = o.name.includes(LIN_TOKEN) || o.name.includes(LABELS_TOKEN);
    o.visible = targetSet.has(o) && !isConnector;
  });
  for (const t of roots) {
    for (let p: THREE.Object3D | null = t; p; p = p.parent) p.visible = true;
  }
}

/** World-space union box of every visible renderable mesh (excludes lines). */
export function computeVisibleUnionBox(roots: Iterable<THREE.Object3D>): THREE.Box3 {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !o.visible) return;
      if (o.name.includes('-line')) return;
      for (let p: THREE.Object3D | null = o.parent; p; p = p.parent) {
        if (!p.visible) return;
      }
      if (!m.geometry) return;
      if (m.geometry.boundingBox === null) m.geometry.computeBoundingBox();
      if (!m.geometry.boundingBox) return;
      tmp.copy(m.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      box.union(tmp);
    });
  }
  return box;
}

/** Aim + size the orthographic camera to contain `box`. */
export function fitOrthoToBox(
  camera: THREE.Camera,
  controls: unknown,
  box: THREE.Box3,
  viewport: { width: number; height: number },
  margin = 1.4,
): boolean {
  const ortho = camera as THREE.OrthographicCamera;
  if (!ortho.isOrthographicCamera) return false;
  if (box.isEmpty()) return false;
  if (viewport.width <= 0 || viewport.height <= 0) return false;

  const center = box.getCenter(new THREE.Vector3());
  const sizeV = box.getSize(new THREE.Vector3());

  ortho.updateMatrixWorld(true);
  const dir = new THREE.Vector3();
  ortho.getWorldDirection(dir);
  ortho.position.copy(center).addScaledVector(dir, -Math.max(sizeV.length() * 2, 5));
  ortho.lookAt(center);
  ortho.updateMatrixWorld(true);

  const aspect = viewport.width / viewport.height;
  const fitWidth = Math.max(sizeV.x, sizeV.y * aspect) * margin;
  const fitHeight = fitWidth / aspect;
  ortho.left = -fitWidth / 2;
  ortho.right = fitWidth / 2;
  ortho.top = fitHeight / 2;
  ortho.bottom = -fitHeight / 2;
  ortho.zoom = 1;
  ortho.updateProjectionMatrix();

  const c = controls as { target?: THREE.Vector3; update?: () => void } | null;
  if (c?.target) {
    c.target.copy(center);
    c.update?.();
  }
  return true;
}

const LINE_MAT = new THREE.MeshBasicMaterial({
  color: 0x6b6b6b,
  transparent: true,
  opacity: 0.25,
  depthWrite: false,
});

const THIN_THRESHOLDS: Record<SystemId, { maxOverMed: number; medOverMin: number }> = {
  nerves: { maxOverMed: 4, medOverMin: 3 },
  vessels: { maxOverMed: 4, medOverMin: 3 },
  insertions: { maxOverMed: 4, medOverMin: 3 },
  skeleton: { maxOverMed: 14, medOverMin: 6 },
  muscles: { maxOverMed: 14, medOverMin: 6 },
  organs: { maxOverMed: 14, medOverMin: 6 },
  joints: { maxOverMed: 14, medOverMin: 6 },
  regions: { maxOverMed: 14, medOverMin: 6 },
};

/** Tint every mesh of `root` with the system colour (idempotent). Parts whose
 *  id is in `contextIds` get a translucent material so they read as background
 *  context rather than the focus structures. */
export function applyTint(
  root: THREE.Object3D,
  tint: string,
  systemId: SystemId,
  contextIds: string[] = [],
): void {
  const color = new THREE.Color(tint);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.userData.__tinted) return;
    if (o.name.includes('-line') || o.name.includes('-lin')) {
      m.material = LINE_MAT;
    } else {
      m.material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
      thinIfElongated(m, systemId);
    }
    m.userData.__tinted = true;
  });

  for (const id of contextIds) {
    const node = findPartByName(root, id);
    if (!node) continue;
    node.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (o.name.includes('-line') || o.name.includes('-lin')) return;
      if (m.userData.__ctxTinted) return;
      m.material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.6,
        metalness: 0.05,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      });
      m.userData.__ctxTinted = true;
    });
  }
}

function thinIfElongated(m: THREE.Mesh, systemId: SystemId): void {
  // nerves/vessels ship as real thin curve-tubes; collapsing re-fattens them.
  if (systemId === 'nerves' || systemId === 'vessels') return;
  if (m.geometry.boundingBox === null) m.geometry.computeBoundingBox();
  const b = m.geometry.boundingBox;
  if (!b) return;
  const sx = b.max.x - b.min.x;
  const sy = b.max.y - b.min.y;
  const sz = b.max.z - b.min.z;
  const sorted = [sx, sy, sz].sort((a, c) => c - a);
  const max = sorted[0];
  const med = sorted[1];
  const min = sorted[2];
  if (med === 0 || min === 0) return;
  const t = THIN_THRESHOLDS[systemId];
  // Plate-collapse (flattening a sheet toward a line) is only wanted for the
  // `insertions` placeholder markers. Real solids (muscles/skeleton/organs/…)
  // have legitimately flat parts — e.g. the abdominal oblique muscles — and
  // collapsing a plate crushes its width into an elongated sliver. So solids
  // only lose genuine wire-like artifacts.
  const wireLike = max / med > t.maxOverMed;
  const plateLike = systemId === 'insertions' && med / min > t.medOverMin;
  if (!wireLike && !plateLike) return;
  const target = Math.min(Math.max(max * 0.01, 0.03), 0.3);
  m.scale.set(
    sx === max ? 1 : target / Math.max(sx, 1e-6),
    sy === max ? 1 : target / Math.max(sy, 1e-6),
    sz === max ? 1 : target / Math.max(sz, 1e-6),
  );
}
