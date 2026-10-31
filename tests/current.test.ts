import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CURRENT_EDDY, createCurrent } from '../src/current.js';
import { TRAVEL_MAX } from '../src/whale-behavior.js';
import { shortestAngle } from '../src/whale-course.js';

test('current is deterministic per seed and differs between seeds', () => {
  const a = createCurrent(42, 0.7);
  const b = createCurrent(42, 0.7);
  const c = createCurrent(7, 0.7);
  let differs = false;
  for (let i = 0; i < 50; i++) {
    const x = i * 1700 - 30000;
    const z = i * 910 + 5000;
    assert.equal(a(x, z), b(x, z));
    if (a(x, z) !== c(x, z)) differs = true;
  }
  assert.ok(differs);
});

test('drift stays within the eddy bound and bends gently along a straight run', () => {
  const bound = Math.asin(CURRENT_EDDY) + 1e-9;
  for (const seed of [42, 7, 1234, 99, 2024, 31337, 1, 2, 3, 4, 5, 6, 8, 9, 10]) {
    const base = 0.3 * seed;
    const current = createCurrent(seed, base);
    let last = current(0, 0);
    let worst = 0;
    for (let d = 0; d <= 300000; d += 100) {
      const h = current(-Math.cos(base) * d, Math.sin(base) * d);
      assert.ok(Math.abs(shortestAngle(base, h)) <= bound, `seed ${String(seed)} drift ${String(shortestAngle(base, h))}`);
      worst = Math.max(worst, Math.abs(shortestAngle(last, h)) / 100);
      last = h;
    }
    // Radians per metre: the spec allows 6 degrees a minute, which at the top cruise speed is 0.0623 rad per km.
    assert.ok(worst < ((6 * Math.PI) / 180 / (TRAVEL_MAX * 60)), `seed ${String(seed)} curvature ${String(worst * 1000)} rad/km`);
  }
});
