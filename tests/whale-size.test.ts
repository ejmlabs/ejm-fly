import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DEFAULT_FRAMING, DIVE_BELOW, FRAMING_DISTANCE, MIN_DISTANCE, WHALE_HALF } from '../src/camera.js';
import { ORBIT_DISTANCE } from '../src/view-controls.js';
import { FLIPPER_LENGTH, FLUKE_HALF_SPAN, WHALE_LOD, buildWhaleGeometry } from '../src/whale-model.js';
import { BREACH_APEX_Y, SHALLOW_Y, SURFACE_Y } from '../src/whale-motion.js';
import { BODY_DEPTH, DEPTH_SCALE, LENGTH_SCALE, WHALE_LENGTH } from '../src/whale-size.js';

const near = (a: number, b: number, what: string) => { assert.ok(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${String(a)} vs ${String(b)}`); };

test('every size derives from the whale length and body depth', () => {
  near(LENGTH_SCALE, WHALE_LENGTH / 12, 'length scale');
  near(DEPTH_SCALE, BODY_DEPTH / 2.5, 'depth scale');
  // Camera distances follow the length.
  near(WHALE_HALF, WHALE_LENGTH / 2, 'framed half length');
  near(MIN_DISTANCE / WHALE_LENGTH, 0.5, 'closest approach');
  near(DEFAULT_FRAMING.distance / WHALE_LENGTH, 16 / 12, 'default framing');
  near(FRAMING_DISTANCE[1] / FRAMING_DISTANCE[0], 40 / 14, 'framing range');
  near(ORBIT_DISTANCE[0] / WHALE_LENGTH, 10 / 12, 'orbit range');
  // Heights against the waterline follow the body depth; the breach height follows the length.
  near(SURFACE_Y / BODY_DEPTH, -0.7 / 2.5, 'surface riding');
  near(SHALLOW_Y / BODY_DEPTH, -1.9 / 2.5, 'glide between blows');
  near(DIVE_BELOW / BODY_DEPTH, -3 / 2.5, 'camera dive line');
  near(BREACH_APEX_Y / WHALE_LENGTH, 0.18, 'breach apex');
  // Anatomy and detail levels are shares of the length.
  near(FLIPPER_LENGTH / WHALE_LENGTH, 0.13, 'flipper');
  near(FLUKE_HALF_SPAN / WHALE_LENGTH, 0.13, 'fluke span');
  for (const levels of Object.values(WHALE_LOD)) for (const level of levels) assert.ok(level.distance === 0 || level.distance > MIN_DISTANCE);
});

test('the built whale is as long as WHALE_LENGTH', () => {
  const geometry = buildWhaleGeometry('medium').geometry;
  const box = geometry.boundingBox;
  assert.ok(box);
  const length = box.max.x - box.min.x;
  assert.ok(Math.abs(length / WHALE_LENGTH - 1) < 0.02, `${String(length)} m`);
});
