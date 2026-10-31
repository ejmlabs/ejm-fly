import { test } from 'vitest';
import assert from 'node:assert/strict';
import { makeNoise2D } from '../src/noise.js';
import { buildTile, tileSize } from '../src/world-tiles.js';
import type { Regions } from '../src/regions.js';

test('tile skirts never hang far into the sea: no dark walls under a coast', () => {
  const level = 3;
  const size = tileSize(level);
  // A coast across the tile: 40 m up at one edge, 12 m deep at the other.
  const land = {
    surfaceAt: (x: number, _z: number, _lod: number, out: { cliff: number }) => {
      out.cliff = 0;
      return 40 - (52 * x) / size;
    },
    regions: {} as Regions,
  };
  const tile = buildTile(land, makeNoise2D(1, 2), level, 0, 0, 16);
  assert.ok(tile);
  let lowest = Infinity;
  for (let i = 1; i < tile.positions.length; i += 3) lowest = Math.min(lowest, tile.positions[i] ?? 0);
  // The grid itself goes down to about 12 m under the sea; no skirt reaches more than 2.5 m below that.
  assert.ok(lowest > -12 - 0.7 - 2.5 - 1e-3, `lowest vertex ${String(lowest)} m`);
  // Up on the land the skirts still hang all the way down to just under the sea, so coarser neighbours show no crack.
  let highSkirt = false;
  for (let i = 1; i < tile.positions.length; i += 3) if ((tile.positions[i - 1] ?? 0) < 1e-3 && Math.abs((tile.positions[i] ?? 0) + 2.5) < 1e-3) highSkirt = true;
  assert.ok(highSkirt, 'skirts below the high edge reach down to the sea');
});
