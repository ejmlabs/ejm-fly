import { test } from 'vitest';
import assert from 'node:assert/strict';
import { layoutWorld } from '../src/terrain.js';
import { CONTINENT, ISLAND, PLAIN, depthForCoastDistance, seabedDepth } from '../src/bathymetry.js';
import { ABYSS, createSeafloor, softDepth } from '../src/seafloor.js';

const slopeDeg = (a: number, b: number, profile = CONTINENT) =>
  (Math.atan((depthForCoastDistance(b, profile) - depthForCoastDistance(a, profile)) / (b - a)) * 180) / Math.PI;

test('the profile runs from the coast over a shelf and a slope onto the abyssal plain', () => {
  assert.equal(depthForCoastDistance(0), 0);
  assert.equal(depthForCoastDistance(-500), 0);
  assert.ok(Math.abs(depthForCoastDistance(CONTINENT.width) - 140) < 1e-6);
  assert.ok(depthForCoastDistance(CONTINENT.width) <= 160);
  // An active margin: a shelf of 10 to 20 km at well under a degree, then an upper slope of about 5 degrees.
  assert.ok(CONTINENT.width >= 10000 && CONTINENT.width <= 20000);
  const slope = slopeDeg(CONTINENT.width + 5000, CONTINENT.width + 15000);
  assert.ok(slope >= 4.5 && slope <= 6, String(slope));
  assert.ok(slopeDeg(1000, CONTINENT.width - 1000) < 1);
  for (const d of [150000, 300000, 1e6]) {
    const depth = depthForCoastDistance(d);
    assert.ok(depth >= 3000 && depth <= 4000 && depth <= PLAIN, `${String(d)} → ${String(depth)}`);
  }
});

test('the profile is continuous and never shallower further out', () => {
  for (const profile of [CONTINENT, ISLAND]) {
    let prev = 0;
    for (let d = 0; d <= 200000; d += 25) {
      const depth = depthForCoastDistance(d, profile);
      assert.ok(depth >= prev - 1e-9, String(d));
      // At most the steepest slope (15°) per step, so no jumps.
      assert.ok(depth - prev <= 25 * Math.tan((16 * Math.PI) / 180), `${String(d)}: ${String(prev)} → ${String(depth)}`);
      prev = depth;
    }
  }
});

test('island flanks drop steeply but the shallower profile always wins', () => {
  // Five kilometres off an islet far out at sea is already deep water.
  assert.ok(seabedDepth(400000, 5000) > 900);
  assert.ok(seabedDepth(400000, 0) === 0);
  // On the continental shelf the water stays shallow even far from any islet.
  assert.ok(seabedDepth(CONTINENT.width / 2, 400000) < 80);
  for (const [c, i] of [[0, 0], [20000, 3000], [90000, 90000], [500000, 12000]] as const) {
    assert.equal(seabedDepth(c, i), Math.min(depthForCoastDistance(c), depthForCoastDistance(i, ISLAND)));
  }
});

test('the seafloor follows a bathymetry: never shallower than the eased land, deep in open ocean, continuous', () => {
  const land = layoutWorld(42, 140).land;
  const plain = createSeafloor(42, land);
  // A synthetic coast distance: open ocean east of x = 0, a shelf and slope toward it.
  const deep = createSeafloor(42, land, (x, z) => (land.maskAt(x, z) > 0 ? 0 : seabedDepth(Math.max(0, x * 60))));
  let deeper = 0;
  for (let i = 0; i < 3000; i++) {
    const x = ((i * 7919) % 6000) - 3000;
    const z = ((i * 104729) % 6000) - 3000;
    const base = land.heightAt(x, z);
    const h = deep.heightAt(x, z);
    assert.ok(Number.isFinite(h));
    if (base >= 0) assert.equal(h, plain.heightAt(x, z));
    // Relief lifts at most about 17 m, abyssal hills at most 300 m.
    else assert.ok(h <= softDepth(base) + 17 + (h < -1700 ? 300 : 0), `${String(base)} → ${String(h)}`);
    if (h < -ABYSS - 3) deeper++;
  }
  assert.ok(deeper > 500, String(deeper));
  // Far out the floor lies on the abyssal plain, hills included.
  for (let z = -3000; z <= 3000; z += 500) {
    const h = deep.heightAt(2900, z);
    if (land.maskAt(2900, z) <= 0) assert.ok(h <= -3000 && h >= -4000, String(h));
  }
  // No cliffs that are not in the profile: neighbouring samples a metre apart differ by little.
  for (let x = 0; x < 3000; x += 7) {
    const a = deep.heightAt(x, 1234);
    const b = deep.heightAt(x + 1, 1234);
    if (land.maskAt(x, 1234) <= 0 && land.maskAt(x + 1, 1234) <= 0) assert.ok(Math.abs(a - b) < 60, `${String(x)}: ${String(a)} ${String(b)}`);
  }
});
