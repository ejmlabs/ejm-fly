import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DEEP_FULL, REGION_BLEND, REGION_LOOKS } from '../src/regions.js';
import { LATITUDE_SPAN } from '../src/planet.js';
import { createRegionLook } from '../src/region-look.js';
import { layoutWorld } from '../src/terrain.js';
import { shipSpecsForCell } from '../src/world-ships.js';
import { item } from '../src/item.js';

const SEEDS = [42, 7, 1234, 99, 2024, 31337];
const regionsOf = (seed: number) => layoutWorld(seed).land.regions;

test('regions are deterministic per seed, weights sum to one, the start is temperate', () => {
  const a = regionsOf(42);
  const b = regionsOf(42);
  const c = regionsOf(43);
  let differs = false;
  for (let i = 0; i < 200; i++) {
    const x = (i - 100) * 3100;
    const z = Math.sin(i) * 90000;
    const wa = a.weightsAt(x, z);
    assert.deepEqual(wa, b.weightsAt(x, z));
    assert.ok(Math.abs(wa[0] + wa[1] + wa[2] + wa[3] - 1) < 1e-9);
    assert.ok(wa.every((w) => w >= 0 && w <= 1 + 1e-12));
    if (c.dominantAt(x, z) !== a.dominantAt(x, z)) differs = true;
  }
  assert.ok(differs);
  for (const seed of SEEDS) {
    const r = regionsOf(seed);
    for (let a = 0; a < 16; a++) assert.equal(r.dominantAt(Math.cos(a) * 5000, Math.sin(a) * 5000), 0, `seed ${String(seed)} start region`);
  }
});

test('region weights change by under 0.01 between samples 10 m apart, along any straight line', () => {
  for (const seed of SEEDS) {
    const r = regionsOf(seed);
    for (let line = 0; line < 6; line++) {
      const angle = line * 1.1 + 0.3;
      const dx = Math.cos(angle) * 10;
      const dz = Math.sin(angle) * 10;
      let last = r.weightsAt(0, 0).slice();
      for (let i = 1; i <= 12000; i++) {
        const w = r.weightsAt(dx * i, dz * i);
        for (let k = 0; k < 4; k++) assert.ok(Math.abs((w[k] ?? 0) - (last[k] ?? 0)) < 0.01, `seed ${String(seed)} line ${String(line)} step ${String(i)} region ${String(k)}`);
        last = w.slice();
      }
    }
  }
});

test('all four regions occur along the migration: climate bands by latitude, deep blue far out at sea', () => {
  for (const seed of SEEDS) {
    const { land } = layoutWorld(seed);
    const seen = new Set<number>();
    for (let s = 0; s < 600000; s += 2000) {
      const { x, z } = land.planet.laneCentre(s);
      const id = land.regions.dominantAt(x, z);
      seen.add(id);
      // Deep blue only out in open ocean, the climate bands by latitude elsewhere.
      if (id === 3) assert.ok(land.planet.openAt(x, z) > DEEP_FULL / 2, `seed ${String(seed)} deep blue ${(land.planet.openAt(x, z) / 1000).toFixed(0)} km from a continent`);
      if (id === 1) assert.ok(land.planet.latitudeAt(x, z) < 0.4, `seed ${String(seed)} tropical at latitude ${land.planet.latitudeAt(x, z).toFixed(2)}`);
      if (id === 2) assert.ok(land.planet.latitudeAt(x, z) > 0.6, `seed ${String(seed)} polar at latitude ${land.planet.latitudeAt(x, z).toFixed(2)}`);
    }
    assert.equal(seen.size, 4, `seed ${String(seed)} regions along 600 km: ${[...seen].join(', ')}`);
  }
  assert.equal(LATITUDE_SPAN, 120000);
  assert.equal(REGION_BLEND, 5000);
}, 60000);

test('the look changes by under 2 percent between frames at 28 m/s', () => {
  // Frames are 28 / 30 m apart at 30 fps; sampling every sixth of them, the allowance is six times as wide.
  const frame = 28 / 30;
  const stride = 6;
  for (const seed of SEEDS) {
    const look = createRegionLook(regionsOf(seed));
    let last: number[] | null = null;
    for (let i = 0; i <= 8000; i++) {
      look.update(i * frame * stride, 900 + i * 0.3);
      const now = [look.water.r, look.water.g, look.water.b, look.fogTint.r, look.fogTint.g, look.fogTint.b, look.fogMix, look.fogDensity, look.hazeDensity, look.land.r, look.land.g, look.land.b, ...look.birds];
      const before = last;
      if (before) now.forEach((v, k) => { assert.ok(Math.abs(v - (before[k] ?? 0)) <= 0.02 * Math.max(Math.abs(before[k] ?? 0), 0.05) * stride, `seed ${String(seed)} step ${String(i)} channel ${String(k)}`); });
      last = now;
    }
  }
});

test('the opening keeps its bay: open water around the start and the way out', () => {
  for (const seed of SEEDS) {
    const { land, whaleHome, journey } = layoutWorld(seed);
    for (let a = 0; a < 24; a++) assert.ok(land.maskAt(Math.cos(a) * 200, Math.sin(a) * 200) < 0, `seed ${String(seed)} land within 200 m of the start`);
    assert.ok(land.clearance(whaleHome.x, whaleHome.z) > 60);
    assert.ok(Number.isFinite(journey));
  }
});

test('regions set the ship density', () => {
  const land = layoutWorld(42).land;
  let sparse = 0;
  let dense = 0;
  for (let cx = -20; cx < 20; cx++) {
    for (let cz = -20; cz < 20; cz++) {
      if (Math.hypot(cx, cz) < 2) continue;
      sparse += shipSpecsForCell(42, cx, cz, land.maskAt, item(REGION_LOOKS, 2).ships).length;
      dense += shipSpecsForCell(42, cx, cz, land.maskAt, item(REGION_LOOKS, 3).ships).length;
    }
  }
  assert.ok(sparse < dense * 0.7, `polar ${String(sparse)} ships against deep blue ${String(dense)}`);
});
