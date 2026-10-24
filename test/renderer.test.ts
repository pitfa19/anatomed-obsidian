import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { applyTint, computeVisibleUnionBox, fitOrthoToBox, setVisibleParts } from '../widget/lib/three-helpers.ts';

function corners(box: THREE.Box3) {
  return [box.min.x, box.max.x].flatMap(x => [box.min.y, box.max.y].flatMap(y => [box.min.z, box.max.z].map(z => new THREE.Vector3(x, y, z))));
}
function contained(camera: THREE.OrthographicCamera, box: THREE.Box3) {
  camera.updateMatrixWorld(true);
  for (const corner of corners(box)) {
    const p = corner.project(camera);
    assert.ok([p.x, p.y, p.z].every(v => Number.isFinite(v) && Math.abs(v) < 1), `clipped corner ${p.toArray()}`);
  }
}
for (const [width, height] of [[1200, 400], [360, 800]]) {
  for (const dimensions of [[0.01, 0.1, 100], [100, 0.01, 1], [1, 100, 0.001], [2000, 5000, 3000], [0.0001, 0.00001, 0.0001], [0, 0, 0]]) {
    test(`fit and orbit ${width}x${height} dimensions ${dimensions}`, () => {
      const center = new THREE.Vector3(50, -25, 300);
      const half = new THREE.Vector3(...dimensions).multiplyScalar(0.5);
      const box = new THREE.Box3(center.clone().sub(half), center.clone().add(half));
      for (const direction of [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 2, 3)]) {
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
        camera.position.copy(center).add(direction);
        camera.lookAt(center);
        const controls = { target: new THREE.Vector3(), update() {} };
        assert.equal(fitOrthoToBox(camera, controls, box, { width, height }), true);
        assert.deepEqual(controls.target.toArray(), center.toArray());
        contained(camera, box);
        const offset = camera.position.clone().sub(center);
        for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 1, 1).normalize()]) {
          for (const angle of [Math.PI / 4, Math.PI / 2, Math.PI]) {
            camera.position.copy(center).add(offset.clone().applyAxisAngle(axis, angle));
            camera.lookAt(center);
            contained(camera, box);
          }
        }
        assert.equal(camera.zoom, 1);
        assert.ok(camera.near >= 0 && camera.far > camera.near);
      }
    });
  }
}
test('invalid fit inputs do not mutate camera', () => {
  const camera = new THREE.OrthographicCamera();
  const before = camera.toJSON();
  const box = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
  for (const viewport of [{ width: 0, height: 10 }, { width: NaN, height: 10 }, { width: 10, height: Infinity }]) assert.equal(fitOrthoToBox(camera, null, box, viewport), false);
  assert.equal(fitOrthoToBox(camera, null, new THREE.Box3(), { width: 1, height: 1 }), false);
  assert.equal(fitOrthoToBox(new THREE.PerspectiveCamera(), null, box, { width: 1, height: 1 }), false);
  assert.equal(fitOrthoToBox(camera, null, box, { width: 1, height: 1 }, 0), false);
  assert.deepEqual(camera.toJSON(), before);
});
test('depth range tolerates the existing target-within-bounds pan clamp', () => {
  const box = new THREE.Box3(new THREE.Vector3(-4, -1, -8), new THREE.Vector3(4, 1, 8));
  const camera = new THREE.OrthographicCamera();
  camera.position.set(1, 2, 3); camera.lookAt(0, 0, 0);
  fitOrthoToBox(camera, null, box, { width: 800, height: 400 });
  const offset = camera.position.clone();
  for (const target of corners(box)) {
    camera.position.copy(target).add(offset); camera.lookAt(target); camera.updateMatrixWorld(true);
    for (const corner of corners(box)) assert.ok(Math.abs(corner.project(camera).z) < 1);
  }
});
test('open surfaces and context render both faces without geometry deformation', () => {
  for (const context of [false, true]) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(10, 4));
    mesh.name = 'fascia';
    const positions = Array.from(mesh.geometry.attributes.position.array);
    const normals = Array.from(mesh.geometry.attributes.normal.array);
    applyTint(mesh, '#abcdef', 'muscles', context ? ['fascia'] : []);
    const material = mesh.material as THREE.MeshStandardMaterial;
    assert.equal(material.side, THREE.DoubleSide);
    assert.equal(material.transparent, context);
    assert.equal(material.depthWrite, !context);
    assert.deepEqual(mesh.scale.toArray(), [1, 1, 1]);
    assert.deepEqual(Array.from(mesh.geometry.attributes.position.array), positions);
    assert.deepEqual(Array.from(mesh.geometry.attributes.normal.array), normals);
    applyTint(mesh, '#abcdef', 'muscles', context ? ['fascia'] : []);
    assert.equal(mesh.material, material);
  }
});
test('real thin tubes remain unchanged including lymphoid, intentional insertion markers still thin', () => {
  for (const system of ['nerves', 'vessels', 'lymphoid'] as const) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(100, 0.01, 0.001));
    mesh.scale.set(2, 3, 4);
    applyTint(mesh, '#ffffff', system as Parameters<typeof applyTint>[2]);
    assert.deepEqual(mesh.scale.toArray(), [2, 3, 4]);
  }
  const marker = new THREE.Mesh(new THREE.BoxGeometry(10, 4, 0.001));
  applyTint(marker, '#ffffff', 'insertions');
  assert.notDeepEqual(marker.scale.toArray(), [1, 1, 1]);
});
test('isolation, connectors and hidden ancestors do not inflate fit bounds', () => {
  const root = new THREE.Group();
  const target = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)); target.name = 'target';
  const other = new THREE.Mesh(new THREE.BoxGeometry(500, 500, 500)); other.name = 'other';
  const connector = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100)); connector.name = 'target-lin';
  target.add(connector); root.add(target, other);
  setVisibleParts(root, ['target']);
  assert.equal(connector.visible, false); assert.equal(other.visible, false);
  assert.deepEqual(computeVisibleUnionBox([root]).getSize(new THREE.Vector3()).toArray(), [2, 2, 2]);
  root.visible = false;
  assert.equal(computeVisibleUnionBox([root]).isEmpty(), true);
});
