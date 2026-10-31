import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createCurrent } from '../src/current.js';
import { createLand } from '../src/land.js';
import { createPlanet } from '../src/planet.js';
import { layoutWorld } from '../src/terrain.js';
import { whaleForward } from '../src/whale-course.js';

const SEEDS = [42, 7, 1234, 99, 2024, 31337];

test('the lane is the path the current carries a swimmer along from the start', () => {
  for (const seed of SEEDS) {
    const heading = (seed % 628) / 100;
    const planet = createPlanet(seed, heading);
    const current = createCurrent(seed, heading);
    let x = 0;
    let z = 0;
    let worst = 0;
    for (let i = 0; i < 3000; i++) {
      const f = whaleForward(current(x, z));
      x += f.x * 100;
      z += f.z * 100;
      worst = Math.max(worst, Math.abs(planet.laneAt(x, z).q));
    }
    assert.ok(worst < 300, `seed ${String(seed)}: ${worst.toFixed(0)} m off the lane after 300 km`);
  }
});

test('the layout is a pure function of seed, heading and view: the order of the samples does not matter', () => {
  const a = createPlanet(42, 1.1);
  const b = createPlanet(42, 1.1);
  const points = Array.from({ length: 400 }, (_, i) => ({ x: Math.sin(i * 12.9) * 600000, z: Math.cos(i * 7.3) * 600000 }));
  const forward = points.map((p) => a.macroAt(p.x, p.z));
  const backward = points.reverse().map((p) => b.macroAt(p.x, p.z)).reverse();
  assert.deepEqual(forward, backward);
  assert.notDeepEqual(forward, points.reverse().map((p) => createPlanet(43, 1.1).macroAt(p.x, p.z)));
});

test('Earth-like at planet scale: about a third land in big continents, the rest wide connected oceans', () => {
  const CELL = 8000;
  const SIDE = 200;
  for (const seed of SEEDS) {
    const planet = createPlanet(seed, (seed % 628) / 100);
    const land = new Uint8Array(SIDE * SIDE);
    for (let j = 0; j < SIDE; j++) for (let i = 0; i < SIDE; i++) land[j * SIDE + i] = planet.macroAt((i - SIDE / 2) * CELL, (j - SIDE / 2) * CELL) > 0 ? 1 : 0;
    const share = land.reduce((a, b) => a + b, 0) / land.length;
    assert.ok(share > 0.2 && share < 0.45, `seed ${String(seed)} land share ${(100 * share).toFixed(0)} percent`);
    // Largest connected landmass and sea on the 8 km grid.
    const largest = (wanted: number): number => {
      const seen = new Uint8Array(land.length);
      let best = 0;
      for (let k = 0; k < land.length; k++) {
        if (seen[k] || land[k] !== wanted) continue;
        const stack = [k];
        seen[k] = 1;
        let size = 0;
        for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
          size++;
          const i = c % SIDE;
          for (const n of [c - 1, c + 1, c - SIDE, c + SIDE]) {
            if (n < 0 || n >= land.length || seen[n] || land[n] !== wanted || Math.abs((n % SIDE) - i) > 1) continue;
            seen[n] = 1;
            stack.push(n);
          }
        }
        best = Math.max(best, size);
      }
      return best;
    };
    // A continent of at least 20,000 square kilometres (about 140 km across), and one ocean holding most of the sea.
    assert.ok(largest(1) * CELL * CELL > 2e10, `seed ${String(seed)} largest landmass ${((largest(1) * CELL * CELL) / 1e6).toFixed(0)} km²`);
    assert.ok(largest(0) > 0.6 * (1 - share) * land.length, `seed ${String(seed)} the largest ocean holds ${((100 * largest(0)) / land.length).toFixed(0)} percent of the map`);
  }
}, 60000);

test('along the migration the horizon is open most of the way: a coast now and then, long open stretches between', () => {
  let total = 0;
  for (const seed of SEEDS) {
    const layout = layoutWorld(seed);
    const land = createLand(seed, { viewYaw: layout.viewYaw, offset: layout.land.offset, landmarks: false });
    let near = 0;
    let samples = 0;
    let run = 0;
    let longest = 0;
    for (let s = 2000; s < 300000; s += 1000) {
      const c = land.planet.laneCentre(s);
      let hit = false;
      for (let d = 500; d <= 6000 && !hit; d += 500) {
        for (let k = 0; k < 12 && !hit; k++) hit = land.maskAt(c.x + Math.cos((k / 12) * Math.PI * 2) * d, c.z + Math.sin((k / 12) * Math.PI * 2) * d) > 0;
      }
      samples++;
      near += hit ? 1 : 0;
      run = hit ? 0 : run + 1000;
      longest = Math.max(longest, run);
    }
    const share = near / samples;
    total += share;
    assert.ok(share > 0.08 && share < 0.5, `seed ${String(seed)}: land within 6 km for ${(100 * share).toFixed(0)} percent of the first 300 km`);
    assert.ok(longest >= 30000, `seed ${String(seed)}: longest open stretch ${(longest / 1000).toFixed(0)} km`);
  }
  const mean = total / SEEDS.length;
  assert.ok(mean > 0.15 && mean < 0.4, `mean coast share ${(100 * mean).toFixed(0)} percent`);
}, 120000);

test('a far lane query neither overflows the stack nor depends on what was asked first', () => {
  const far = createPlanet(42, 1.1);
  const near = createPlanet(42, 1.1);
  // About 20,000 chunks out each way: deep enough to overflow a recursive build.
  for (const s of [2.6e9, -2.6e9]) {
    for (let t = 0; t < Math.abs(s); t += Math.abs(s) / 8) near.laneCentre(Math.sign(s) * t);
    assert.deepEqual(far.laneCentre(s), near.laneCentre(s));
  }
});

test('a point that is not a number is open sea, not a crash or a NaN mask', () => {
  const planet = createPlanet(42, 1.1);
  for (const [x, z] of [[NaN, 0], [0, Infinity], [-Infinity, NaN]] as const) {
    assert.equal(planet.macroAt(x, z), -1.6);
    assert.equal(planet.openAt(x, z), Infinity);
    assert.ok(Number.isNaN(planet.laneAt(x, z).q));
  }
});
