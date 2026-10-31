import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DEEP_DIVE_Y, FLOOR_CLEARANCE, SURFACE_Y, floorLimit, whalePose } from '../src/whale-motion.js';
import { DEPTH_SCALE } from '../src/whale-size.js';

test('the deep pose reaches below −10 m', () => {
  let lowest = 0;
  for (let x = 0; x <= 1; x += 0.005) lowest = Math.min(lowest, whalePose('deep', x).y);
  assert.ok(lowest < -10 && lowest > DEEP_DIVE_Y - 1.5, String(lowest));
});

test('floor limit keeps clearance, is continuous, and leaves surface riding alone', () => {
  for (const floorY of [-40, -18, -12, -8, -6].map((y) => y * DEPTH_SCALE)) {
    let prev = floorLimit(-20, floorY);
    for (let y = -20; y <= 2; y += 0.01) {
      const v = floorLimit(y, floorY);
      assert.ok(v >= y - 1e-9 && v >= floorY + FLOOR_CLEARANCE - 1e-9, `${String(floorY)} ${String(y)} → ${String(v)}`);
      assert.ok(Math.abs(v - prev) < 0.02, 'continuous');
      prev = v;
    }
  }
  assert.equal(floorLimit(-14, undefined), -14);
  assert.equal(floorLimit(SURFACE_Y, -3 * DEPTH_SCALE), SURFACE_Y);
  assert.equal(floorLimit(-30, -100), -30);
});
