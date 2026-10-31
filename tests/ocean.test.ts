import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { FOAM_DRIFT, FOAM_PERIOD, createOcean } from '../src/ocean.js';
import { patchShader } from '../src/shader-patch.js';
import { setSea as setSwell } from '../src/swell.js';

/** A Vector2 uniform of the water material, checked. */
function vector2(material: THREE.ShaderMaterial, name: string): THREE.Vector2 {
  const value: unknown = material.uniforms[name]?.value;
  if (!(value instanceof THREE.Vector2)) throw new Error(`${name} is not a Vector2 uniform`);
  return value;
}

/** A Vector4 uniform of the water material, checked. */
function vector4(material: THREE.ShaderMaterial, name: string): THREE.Vector4 {
  const value: unknown = material.uniforms[name]?.value;
  if (!(value instanceof THREE.Vector4)) throw new Error(`${name} is not a Vector4 uniform`);
  return value;
}

test('patchShader applies every patch in order, taking replacements literally', () => {
  assert.equal(patchShader('a b c', [{ find: 'a', replace: 'x' }, { find: 'c', replace: 'y$&' }]), 'x b y$&');
});

test('patchShader returns null rather than a half-patched shader', () => {
  assert.equal(patchShader('a b c', [{ find: 'a', replace: 'x' }, { find: 'missing', replace: 'y' }]), null);
});

test('the bundled three.js Water shader takes every patch', () => {
  const stock = (new Water(new THREE.PlaneGeometry(1, 1), { textureWidth: 4, textureHeight: 4 }).material)
    .fragmentShader;
  const shelf = { data: new Uint8Array(4), size: 2, min: -50, extent: 100 };
  const ocean = createOcean(1, new THREE.Vector3(0, 1, 0), { textureSize: 4, shelves: { near: shelf, far: shelf } });
  const material = ocean.water.material;
  assert.notEqual(material.fragmentShader, stock);
  for (const declaration of ['uniform vec3 reflectionHaze;', 'uniform float reflectionLift;', 'uniform sampler2D shelfNear;']) {
    assert.ok(material.fragmentShader.includes(declaration), declaration);
  }
  assert.ok(material.fragmentShader.includes('shelfMix'));
  for (const name of ['reflectionHaze', 'reflectionLift', 'shelfNear', 'shelfFar', 'shallowLight']) assert.ok(material.uniforms[name], name);
  ocean.dispose();
});

test('ripples and shelf maps stay fixed to the world when the origin moves', () => {
  const near = { data: new Uint8Array(16), size: 4, min: -150, extent: 300 };
  const far = { data: new Uint8Array(16), size: 4, min: 900, minZ: -600, extent: 1200 };
  const ocean = createOcean(1, new THREE.Vector3(0, 1, 0), { textureSize: 4, shelves: { near, far } });
  const material = ocean.water.material;
  for (const name of ['uniform vec4 rippleShiftA;', 'rippleShiftA.xy', 'rippleShiftB.zw']) assert.ok(material.fragmentShader.includes(name), name);
  const bounds = () => vector4(material, 'shelfFarBounds').clone();
  const before = bounds();
  // Texel centres map to world via min − texel / 2; recentring shifts render bounds by −origin.
  assert.ok(Math.abs(before.x - (900 - 200)) < 1e-9 && Math.abs(before.y - (-600 - 200)) < 1e-9);
  ocean.setOrigin(1024, -2048);
  const after = bounds();
  assert.ok(Math.abs(after.x - (before.x - 1024)) < 1e-9 && Math.abs(after.y - (before.y + 2048)) < 1e-9);
  // Ripple offsets are reduced to their texture period, so the GPU never sees large numbers.
  const shift = vector4(material, 'rippleShiftA');
  for (const v of shift.toArray()) assert.ok(v >= 0 && v < 1);
  assert.ok(Math.abs(shift.x - (((1024 * 1.2) / 103) % 1)) < 1e-9);
  // A rebaked map swaps in with its own bounds.
  ocean.setShelves({ near: { ...near, min: 5000, minZ: 6000 } });
  const nb = vector4(material, 'shelfNearBounds');
  assert.ok(Math.abs(nb.x - (5000 - 50 - 1024)) < 1e-9 && Math.abs(nb.y - (6000 - 50 + 2048)) < 1e-9);
  // The plane follows the camera in render space.
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(300, 5, -700);
  ocean.update(0.016, new THREE.Vector3(0, 1, 0), camera);
  assert.equal(ocean.water.position.x, 300);
  assert.equal(ocean.water.position.z, -700);
  ocean.dispose();
});

test('the foam lattice stays fixed to the world across recentres, and moves with the sea clock alone', () => {
  const windAngle = 1.1;
  setSwell(0.9, windAngle);
  const ocean = createOcean(1, new THREE.Vector3(0, 1, 0), { textureSize: 4 });
  const material = ocean.water.material;
  for (const name of ['foamTexture', 'uniform vec2 foamShift;', 'fwidth( foamAt )']) assert.ok(material.fragmentShader.includes(name), name);
  const wind = vector2(material, 'foamWind');
  const shift = vector2(material, 'foamShift');
  const wrap = (v: number) => v - Math.floor(v / FOAM_PERIOD) * FOAM_PERIOD;
  /** Where a world point sits on the lattice, from the render position the shader is given. */
  const lattice = (wx: number, wz: number, origin: { x: number; z: number }) => {
    const x = wx - origin.x;
    const z = wz - origin.z;
    return { along: wrap(wind.x * x + wind.y * z + shift.x), across: wrap(wind.x * z - wind.y * x + shift.y) };
  };
  /** Distance between two lattice coordinates, round the period. */
  const gap = (a: number, b: number) => Math.abs(wrap(a - b + FOAM_PERIOD / 2) - FOAM_PERIOD / 2);

  ocean.setSea(10, 1, 5);
  assert.ok(Math.abs(wind.x - Math.cos(windAngle)) < 1e-6 && Math.abs(wind.y - Math.sin(windAngle)) < 1e-6);
  const home = lattice(1234.5, -987.25, { x: 0, z: 0 });
  for (const origin of [{ x: 2048, z: -1024 }, { x: -512, z: 8192 }]) {
    // Right after the move, before the next frame sets the sea, and again after it.
    ocean.setOrigin(origin.x, origin.z);
    for (let frame = 0; frame < 2; frame++) {
      const moved = lattice(1234.5, -987.25, origin);
      assert.ok(gap(moved.along, home.along) < 1e-6 && gap(moved.across, home.across) < 1e-6);
      ocean.setSea(10, 1, 5);
    }
  }
  for (const v of shift.toArray()) assert.ok(v >= 0 && v < FOAM_PERIOD);

  // Wall time does not move it (the swell's clock stops under reduced motion); the clock carries it downwind.
  const still = shift.clone();
  ocean.update(5, new THREE.Vector3(0, 1, 0));
  ocean.setSea(10, 1, 5);
  assert.ok(shift.equals(still));
  const origin = { x: -512, z: 8192 };
  const before = lattice(0, 0, origin);
  ocean.setSea(14, 1, 5);
  const after = lattice(0, 0, origin);
  assert.ok(gap(after.along, before.along - FOAM_DRIFT * 4) < 1e-6 && gap(after.across, before.across) < 1e-6);
  ocean.dispose();
  setSwell(0, 0);
});
