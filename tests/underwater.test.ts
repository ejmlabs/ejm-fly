import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SURFACE_BAND, waterSignal } from '../src/seams.js';
import {
  VISIBLE_LIGHT,
  WATER_IOR,
  WATER_LOOK,
  airAngle,
  blendFog,
  criticalAngle,
  depthLight,
  seenLight,
  surfaceLight,
  waterTint,
  type FogState,
} from '../src/underwater-optics.js';
import { acesFilmic, radianceFor } from '../src/tone.js';
import { floorCentre, visualFloor } from '../src/underwater-floor.js';

test('water signal is 0 above the band, 1 below, and smooth and monotonic across it', () => {
  assert.equal(waterSignal(SURFACE_BAND + 0.01).submersion, 0);
  assert.equal(waterSignal(5).submersion, 0);
  assert.equal(waterSignal(-SURFACE_BAND - 0.01).submersion, 1);
  assert.equal(waterSignal(-20).submersion, 1);
  assert.equal(waterSignal(-3).depth, 3);
  assert.equal(waterSignal(2).depth, -2);
  let prev = -1;
  let flips = 0;
  let wasUnder = false;
  for (let y = 1; y >= -1; y -= 0.001) {
    const s = waterSignal(y);
    assert.ok(s.submersion >= prev - 1e-12, `monotonic at ${String(y)}`);
    if (prev >= 0) assert.ok(s.submersion - prev < 0.01, `continuous at ${String(y)}`);
    assert.equal(s.underwater, s.submersion > 0.5);
    if (s.underwater !== wasUnder) flips++;
    wasUnder = s.underwater;
    prev = s.submersion;
  }
  assert.equal(flips, 1);
  assert.ok(Math.abs(waterSignal(0).submersion - 0.5) < 1e-9);
  // Reuses the output object.
  const out = { depth: 0, submersion: 0, underwater: false };
  assert.equal(waterSignal(-1, out), out);
});

test('fog blend hits both endpoints and moves monotonically between them', () => {
  const above: FogState = { color: new THREE.Color(0.4, 0.5, 0.58), density: 0.00034 };
  const below: FogState = { color: new THREE.Color(0.02, 0.1, 0.13), density: 0.031 };
  const out: FogState = { color: new THREE.Color(), density: 0 };
  blendFog(above, below, 0, out);
  assert.ok(out.color.equals(above.color));
  assert.ok(Math.abs(out.density - above.density) < 1e-12);
  blendFog(above, below, 1, out);
  assert.ok(Math.abs(out.color.r - below.color.r) < 1e-9 && Math.abs(out.color.b - below.color.b) < 1e-9);
  assert.ok(Math.abs(out.density - below.density) < 1e-12);
  let last = { d: 0, r: Infinity, b: Infinity };
  for (let s = 0; s <= 1.0001; s += 0.01) {
    blendFog(above, below, s, out);
    assert.ok(out.density >= last.d, `density monotonic at ${String(s)}`);
    assert.ok(out.color.r <= last.r + 1e-12 && out.color.b <= last.b + 1e-12, `colour monotonic at ${String(s)}`);
    last = { d: out.density, r: out.color.r, b: out.color.b };
  }
  // Clamped outside 0..1.
  blendFog(above, below, 3, out);
  assert.ok(Math.abs(out.density - below.density) < 1e-12);
});

test("Snell's window: critical angle ≈ 48.6° for sea water; light passes inside it, reflects outside", () => {
  const deg = (criticalAngle(WATER_IOR) * 180) / Math.PI;
  assert.ok(Math.abs(deg - 48.6) < 0.1, String(deg));
  assert.equal(airAngle(0), 0);
  const inside = airAngle((40 * Math.PI) / 180);
  assert.ok(inside !== null && inside > (40 * Math.PI) / 180 && inside < Math.PI / 2);
  assert.equal(airAngle((50 * Math.PI) / 180), null);
  assert.equal(airAngle((80 * Math.PI) / 180), null);
  // Just inside the edge, the ray leaves almost along the horizon.
  const edge = airAngle(criticalAngle() - 1e-4);
  assert.ok(edge !== null && edge > (85 * Math.PI) / 180);
});

test('underwater tint darkens with depth and visibility stays in the 55–90 m range of clear open ocean', () => {
  const a: FogState = { color: new THREE.Color(), density: 0 };
  const b: FogState = { color: new THREE.Color(), density: 0 };
  waterTint(0, 1, a);
  waterTint(20, 1, b);
  assert.ok(b.color.r + b.color.g + b.color.b < a.color.r + a.color.g + a.color.b);
  assert.ok(b.density >= a.density);
  for (const f of [a, b]) {
    const visibility = Math.sqrt(-Math.log(0.05)) / f.density;
    assert.ok(visibility > 55 && visibility < 90, String(visibility));
    assert.ok(f.color.b > f.color.r, 'blue-green, not red');
  }
  assert.ok(surfaceLight(0) === 1 && surfaceLight(10) < surfaceLight(5));
  assert.equal(WATER_LOOK.deepDensity >= WATER_LOOK.density, true);
});

test('radiance solver round-trips display colours through ACES, including dark deep water', () => {
  for (const depth of [0, 4, 12, 30]) {
    const tint: FogState = { color: new THREE.Color(), density: 0 };
    waterTint(depth, 0.5, tint);
    const radiance = radianceFor(tint.color, 0.42);
    const back = acesFilmic(radiance, 0.42);
    for (const c of ['r', 'g', 'b'] as const) {
      assert.ok(Number.isFinite(radiance[c]) && radiance[c] >= 0);
      // ACES desaturates: a channel it cannot pull low enough ends at zero radiance instead.
      const reached = Math.abs(back[c] - tint.color[c]) < 0.004;
      const floored = radiance[c] < 1e-4 && back[c] > tint.color[c] && back[c] < tint.color[c] + 0.05;
      assert.ok(reached || floored, `${String(depth)} ${c}: ${String(back[c])} vs ${String(tint.color[c])}`);
    }
  }
});

test('seafloor patch: drawn floor never sits above the real one and centres snap deterministically', () => {
  for (const h of [-60, -34, -12, -1, 0.5]) {
    const v = visualFloor(h);
    assert.ok(v <= h && v > h - 0.2);
  }
  assert.ok(visualFloor(300) <= 2);
  assert.equal(floorCentre(0, 2), 0);
  assert.equal(floorCentre(7.9, 2), 4);
  assert.equal(floorCentre(-9, 2), -4);
  assert.equal(floorCentre(1000.3, 2), floorCentre(1000.3, 2));
});

test('view fog weight: none well above, full well below, never decreasing on the way down', async () => {
  const { fogMix } = await import('../src/underwater.js');
  let prev = -1;
  for (let y = 1; y >= -1; y -= 0.002) {
    const s = waterSignal(y);
    const m = fogMix(s.depth, s.submersion);
    assert.ok(m >= prev - 1e-12 && m >= 0 && m <= 1, String(y));
    prev = m;
  }
  assert.equal(fogMix(-1, 0), 0);
  assert.equal(fogMix(1, 1), 1);
});

test('light fails with depth, red first and blue last, and the deep stays dim but visible', () => {
  const c = depthLight(30, new THREE.Color());
  assert.ok(c.r < 0.001 && c.g < c.b && c.b > 0.4, `30 m: ${String(c.r)} ${String(c.g)} ${String(c.b)}`);
  assert.equal(seenLight(0), 1);
  let prev = 1;
  for (let d = 5; d <= 300; d += 5) {
    assert.ok(seenLight(d) <= prev + 1e-12, `brighter at ${String(d)} m`);
    prev = seenLight(d);
  }
  assert.ok(seenLight(60) < 0.5, 'dim by 60 m');
  assert.equal(seenLight(200), VISIBLE_LIGHT);
  assert.equal(seenLight(300), VISIBLE_LIGHT);
});
