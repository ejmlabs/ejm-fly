import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createSliceCost } from '../src/slice-cost.js';

test('a slice cost reserves the longest recent slice and lets a job that has not run start', () => {
  const cost = createSliceCost();
  assert.ok(cost.fits(0.01), 'a job with no history starts whenever any time is left');
  cost.note(0.4);
  assert.ok(!cost.fits(0.39) && cost.fits(0.41), 'the 0.4 ms slice is the reserve');
  cost.note(0.1);
  assert.ok(!cost.fits(0.38), 'a short slice after it does not lower the reserve at once');
});

test('a slow slice is forgotten as faster ones follow', () => {
  const cost = createSliceCost();
  cost.note(0.8);
  for (let i = 0; i < 200; i++) cost.note(0.1);
  assert.ok(cost.fits(0.2), 'the reserve is back near the typical slice');
  assert.ok(!cost.fits(0.05));
});

test('no slice is so slow that its job is starved of a turn', () => {
  const cost = createSliceCost();
  cost.note(40);
  assert.ok(cost.fits(1.1), 'a millisecond and a bit is enough to run another slice of any job');
  assert.ok(!cost.fits(0.9));
});
