import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FISH_SPECIES } from '../src/fish-species.js';
import { buildFish, createFishMesh, patchFishShader, type FishLevel } from '../src/fish-mesh.js';
import { item } from '../src/item.js';

test('the species table covers forage, open-water, deep, drifting, bottom and reef fish', () => {
  const names = FISH_SPECIES.map((s) => s.name);
  assert.deepEqual(names, ['sardine', 'mackerel', 'tuna', 'lanternfish', 'jellyfish', 'ray', 'reef']);
  assert.deepEqual(new Set(FISH_SPECIES.map((s) => s.shape)), new Set(['fish', 'ray', 'jelly']));
  for (const s of FISH_SPECIES) {
    assert.ok(s.depth[0] >= 0 && s.depth[0] < s.depth[1] && s.depth[1] <= 1000, s.name);
    assert.ok(s.school[0] >= 1 && s.school[0] <= s.school[1], s.name);
    assert.ok(s.length > 0 && s.beat > 0 && s.sway > 0 && s.sway < 0.3, s.name);
  }
  // Lanternfish live deep and carry their own light.
  const lantern = FISH_SPECIES.find((s) => s.name === 'lanternfish');
  assert.ok(lantern);
  assert.ok(lantern.depth[0] >= 200 && lantern.glow > 0.5);
});

test('meshes stay within 150 triangles and get cheaper at every level', () => {
  for (const s of FISH_SPECIES) {
    let previous = Infinity;
    for (const level of [0, 1, 2] as FishLevel[]) {
      const g = buildFish(s, level);
      const triangles = g.getAttribute('position').count / 3;
      assert.ok(triangles > 0 && triangles <= 150 && triangles < previous, `${s.name} ${String(level)}: ${String(triangles)}`);
      previous = triangles;
      const normal = g.getAttribute('normal').array;
      assert.ok(Array.from(normal).every(Number.isFinite), `${s.name} normals`);
      // Built at unit length: a ray's whip tail is the longest reach.
      g.computeBoundingBox();
      const box = g.boundingBox;
      assert.ok(box);
      assert.ok(box.min.x >= -0.86 && box.max.x <= 0.5 + 1e-9, `${s.name} x ${String(box.min.x)}..${String(box.max.x)}`);
      if (s.shape === 'fish') assert.ok(Math.abs(box.max.x - 0.5) < 1e-9, 'nose at +x');
      g.dispose();
    }
  }
});

test('the swim patches three’s Lambert shader at its injection points', () => {
  const time = { value: 0 };
  for (const s of FISH_SPECIES) {
    const lambert = THREE.ShaderLib.lambert;
    const shader = { uniforms: {}, vertexShader: lambert.vertexShader, fragmentShader: lambert.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    patchFishShader(shader, s, time);
    assert.match(shader.vertexShader, /attribute vec2 aSwim;[\s\S]*float swimW = [^;]*uTime/);
    assert.match(shader.vertexShader, /transformed\.(z|y|xz) [+*]=/);
    assert.match(shader.fragmentShader, /uniform vec3 uGlow;[\s\S]*outgoingLight \+= uGlow;\n#include <opaque_fragment>/);
    // Only the shared clock moves the swim, so a held clock (reduced motion) holds every fish still.
    assert.equal(shader.uniforms['uTime'], time);
  }
});

test('instanced fish get seeded swim phases and rates near 1', () => {
  const time = { value: 0 };
  const a = createFishMesh(item(FISH_SPECIES, 0), 1, 64, time);
  const b = createFishMesh(item(FISH_SPECIES, 0), 1, 64, time);
  const swim = a.geometry.getAttribute('aSwim') as THREE.InstancedBufferAttribute;
  assert.equal(swim.count, 64);
  assert.deepEqual(swim.array, b.geometry.getAttribute('aSwim').array);
  for (let i = 0; i < 64; i++) {
    assert.ok(swim.getX(i) >= 0 && swim.getX(i) < Math.PI * 2);
    assert.ok(swim.getY(i) >= 0.85 && swim.getY(i) <= 1.15);
  }
  for (const mesh of [a, b]) {
    mesh.geometry.dispose();
    mesh.dispose();
  }
});
