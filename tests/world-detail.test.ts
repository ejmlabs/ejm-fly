import { test, expect } from 'vitest';
import * as THREE from 'three';
import assert from 'node:assert/strict';
import { SWELL_MAX, swellAt } from '../src/swell.js';
import { selectLod } from '../src/lod.js';
import { createQuality, detailFor, updateQuality } from '../src/quality.js';
import { stepFlock, type Boid } from '../src/flock.js';
import { createBirds } from '../src/birds.js';
import { buildBird, SPECIES, triangleCount } from '../src/bird-mesh.js';
import { item } from '../src/item.js';

test('swell is deterministic, bounded and its slope matches the height', () => {
  const a = swellAt(120.5, -33, 7.25);
  const b = swellAt(120.5, -33, 7.25);
  assert.deepEqual(a, b);
  let peak = 0;
  for (let i = 0; i < 4000; i++) peak = Math.max(peak, Math.abs(swellAt(i * 3.7, i * -1.9, i * 0.05).height));
  assert.ok(peak <= SWELL_MAX + 1e-9 && peak > SWELL_MAX * 0.6, `peak ${String(peak)}`);
  const e = 0.01;
  const slope = swellAt(50, 20, 3);
  const dx = (swellAt(50 + e, 20, 3).height - swellAt(50 - e, 20, 3).height) / (2 * e);
  const dz = (swellAt(50, 20 + e, 3).height - swellAt(50, 20 - e, 3).height) / (2 * e);
  assert.ok(Math.abs(slope.slopeX - dx) < 1e-4 && Math.abs(slope.slopeZ - dz) < 1e-4);
  assert.ok(Math.hypot(slope.slopeX, slope.slopeZ) < 0.1, 'gentle enough for a ship to roll under 4 degrees');
});

test('LOD selection steps with hysteresis and does not thrash', () => {
  const bounds = [40, 120];
  assert.equal(selectLod(0, 10, bounds), 0);
  assert.equal(selectLod(0, 100, bounds), 1);
  assert.equal(selectLod(0, 400, bounds), 2);
  assert.equal(selectLod(0, 41, bounds), 0, 'inside the hysteresis band stays put');
  assert.equal(selectLod(1, 39, bounds), 1);
  assert.equal(selectLod(1, 35, bounds), 0);
  let level = 0;
  let changes = 0;
  for (let i = 0; i < 100; i++) {
    const next = selectLod(level, 40 + (i % 2 ? 1 : -1), bounds);
    if (next !== level) changes++;
    level = next;
  }
  assert.equal(changes, 0);
});

test('detail follows the quality tier and steps down with it', () => {
  assert.deepEqual(detailFor('low'), { birds: 10, ships: 4, objects: 36, walkers: 64, microNormal: 'off' });
  assert.equal(detailFor('medium').birds, 16);
  assert.equal(detailFor('high').birds, 24);
  const state = createQuality({ software: false, cores: 16, memory: 16, dpr: 2 });
  expect(state.tier).toBe('high');
  for (let i = 0; i < 80 && state.tier === 'high'; i++) updateQuality(state, 100);
  assert.equal(state.tier, 'medium');
  assert.equal(detailFor(state.tier).birds, 16);
});

function flock(count: number): Boid[] {
  return Array.from({ length: count }, (_, i) => ({
    x: Math.cos(i) * 40, y: 20 + (i % 4), z: Math.sin(i) * 40, vx: 5, vy: 0, vz: 5, group: 0, size: 1,
  }));
}

test('a flock stays bounded, above the water, and follows its leader without teleporting', () => {
  const boids = flock(12);
  const leader = { x: 0, y: 25, z: 0 };
  const params = { speeds: [9], minHeight: 5, maxHeight: 70 };
  let farthest = 0;
  for (let step = 0; step < 6000; step++) {
    // The leader drifts a kilometre away over the run.
    leader.x = step * 0.2;
    const before = boids.map((b) => [b.x, b.z]);
    stepFlock(boids, [leader], params, 0.1);
    boids.forEach((b, i) => { assert.ok(Math.hypot(b.x - (item(before, i)[0] ?? 0), b.z - (item(before, i)[1] ?? 0)) < 20 * 0.1 + 1e-6, 'no jump'); });
    for (const b of boids) {
      assert.ok(b.y >= 5 && b.y <= 70);
      farthest = Math.max(farthest, Math.hypot(b.x - leader.x, b.z - leader.z));
    }
  }
  assert.ok(farthest < 400, `flock stays near its leader: ${String(farthest)}`);
});

test('boids keep apart', () => {
  const boids = flock(2);
  item(boids, 0).x = 0; item(boids, 0).z = 0; item(boids, 1).x = 0.5; item(boids, 1).z = 0;
  item(boids, 0).y = item(boids, 1).y = 20;
  stepFlock(boids, [{ x: 0, y: 20, z: 0 }], { speeds: [9], minHeight: 5, maxHeight: 70 }, 0.5);
  assert.ok(Math.hypot(item(boids, 0).x - item(boids, 1).x, item(boids, 0).z - item(boids, 1).z) > 0.5);
});

test('bird meshes have three levels of detail with a wing weight and no lines or points', () => {
  for (const species of SPECIES) {
    const counts = ([0, 1, 2] as const).map((level) => {
      const geometry = buildBird(species, level);
      const wing = geometry.getAttribute('wing');
      let max = 0;
      for (let i = 0; i < wing.count; i++) max = Math.max(max, wing.getX(i));
      assert.equal(max, 1, 'wing tips carry full weight');
      return triangleCount(geometry);
    });
    assert.ok((counts[0] ?? 0) > (counts[1] ?? 0) && (counts[1] ?? 0) > (counts[2] ?? 0), `${species.name}: ${String(counts)}`);
    assert.ok((counts[0] ?? 0) <= 200 && (counts[2] ?? 0) >= 8, `${species.name}: ${String(counts)}`);
  }
});

test('birds fade out on a tier step-down and rejoin their leaders on step-up', () => {
  const birds = createBirds(7, 'high');
  const camera = { x: 0, y: 20, z: 0 };
  let t = 0;
  const run = (seconds: number, cx: number) => {
    for (let i = 0; i < seconds * 30; i++) {
      t += 1 / 30;
      birds.update(t, cx, 0, 1 / 30, camera, false);
    }
  };
  const instances = () => birds.group.children.reduce((n, mesh) => n + (mesh as THREE.InstancedMesh).count, 0);
  run(2, 0);
  assert.equal(instances(), 24);
  birds.setTier('medium');
  birds.update((t += 1 / 30), 0, 0, 1 / 30, camera, false);
  assert.ok(instances() >= 23, 'no bird vanishes in a single frame');
  run(2, 0);
  assert.equal(instances(), 16);
  birds.setTier('high');
  run(1, 1000);
  run(2, 1000);
  assert.equal(instances(), 24);
  // The whale moved 1 km while the extra birds were away: they must rejoin the flock, not stay behind.
  const xs: number[] = [];
  const matrix = new THREE.Matrix4();
  for (const mesh of birds.group.children as THREE.InstancedMesh[]) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      xs.push(matrix.elements[12]);
    }
  }
  assert.ok(Math.max(...xs) - Math.min(...xs) < 400, `flock spans ${String(Math.max(...xs) - Math.min(...xs))} m`);
  birds.dispose();
});
