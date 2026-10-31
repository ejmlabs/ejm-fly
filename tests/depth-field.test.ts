import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createDepthField } from '../src/depth-field.js';
import { createSeafloor } from '../src/seafloor.js';
import { layoutWorld } from '../src/terrain.js';

const islands = [
  { x: 2000, z: -1500, r: 300 },
  { x: -9000, z: 4000, r: 1200 },
  { x: 30000, z: 30000, r: 50 },
];
/** A mask about 1 per 500 m from each island's shore, > 0 on land. */
const mask = (x: number, z: number) => Math.max(...islands.map((i) => (i.r - Math.hypot(x - i.x, z - i.z)) / 500));
const trueDistance = (x: number, z: number) => Math.max(0, Math.min(...islands.map((i) => Math.hypot(x - i.x, z - i.z) - i.r)));

test('the depth field is the distance to the nearest land, clamped at its reach', () => {
  const field = createDepthField(mask, { cell: 100, tile: 32, reach: 6000 });
  for (const [x, z] of [[2000, -1500], [2600, -1500], [0, 0], [-6000, 1000], [-9000, 9000], [12000, -12000], [29000, 30500]] as const) {
    const expected = Math.min(6000, trueDistance(x, z));
    // A lattice point counts as land within about 200 m of the shore (the land threshold), give or take a cell.
    assert.ok(Math.abs(field.coastDistanceAt(x, z) - Math.max(0, expected - 200)) < 250, `${String(x)},${String(z)}: ${String(field.coastDistanceAt(x, z))} vs ${String(expected)}`);
  }
  assert.equal(field.coastDistanceAt(NaN, 0), 6000);
});

test('prefetch builds the tiles around a point in small slices', () => {
  let t = 0;
  const field = createDepthField(mask, { cell: 100, tile: 32, reach: 3000, now: () => (t += 0.01) });
  let calls = 0;
  // The fake clock moves 0.01 ms a reading: a 0.02 ms budget is a step or two of rows per call.
  while (!field.prefetch(0, 0, 0.02) && calls < 100000) calls++;
  assert.equal(field.stats().tiles, 9);
  assert.ok(calls > 9, 'each tile takes several slices');
  // A prefetched tile answers without building anything more.
  field.coastDistanceAt(100, 100);
  assert.equal(field.stats().tiles, 9);
});

test('the open sea of the journey deepens off every shore without a cliff', () => {
  const land = layoutWorld(42).land;
  const floor = createSeafloor(42, land, land.depthAt);
  const h = land.planet.heading + 1.2;
  const fx = -Math.cos(h);
  const fz = Math.sin(h);
  let prev = NaN;
  let worst = 0;
  let deepest = 0;
  for (let d = 0; d <= 70000; d += 50) {
    const x = fx * d;
    const z = fz * d;
    const wet = land.heightAt(x, z) < -5;
    const y = floor.heightAt(x, z);
    if (wet && Number.isFinite(prev)) worst = Math.max(worst, Math.abs(y - prev));
    prev = wet ? y : NaN;
    deepest = Math.max(deepest, -y);
  }
  assert.ok(worst < 40, `steepest 50 m step ${String(worst)} m`);
  assert.ok(deepest > 300, `deepest ${String(deepest)} m`);
}, 60000);
