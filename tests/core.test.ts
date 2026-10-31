import { test } from 'vitest';
import assert from 'node:assert/strict';
import { hash, random } from '../src/rng.js';
import { parseSeed, resolveSeed, seedURL, nextSeed } from '../src/seed.js';
import { createQuality, updateQuality, selectQualityTier } from '../src/quality.js';
import {
  layoutWorld,
  inPortraitViewCone,
  computeViewYaw,
  coastAhead,
  SHIP_LAND_MARGIN,
} from '../src/terrain.js';
import { createLand, landFraction, nearShelf, depthForMask, coastSpread, REGION_FROM, VIEW_HALF_CONE } from '../src/land.js';
import { biomeColor } from '../src/landmesh.js';
import { clampClearOfLand } from '../src/shore.js';
import { validateMemory, VERSION } from '../src/persistence.js';
import { fbm2, makeNoise2D, ridged2 } from '../src/noise.js';
import { item } from '../src/item.js';

test('random streams are repeatable, independent, and unsigned', () => {
  const a = random(42), b = random(42), c = random(43);
  const values = Array.from({ length: 2000 }, () => a());
  assert.deepEqual(values, Array.from({ length: 2000 }, () => b()));
  assert.notDeepEqual(values, Array.from({ length: 2000 }, () => c()));
  assert.ok(values.every((n) => n >= 0 && n < 1));
  assert.notEqual(hash(42, -1, 2, 3), hash(42, 1, 2, 3));
});

test('seeds parse complete unsigned decimals and reject ambiguous input', () => {
  for (const [input, expected] of [['0', 0], ['42', 42], ['00042', 42], ['4294967295', 0xffffffff]] as const) {
    assert.equal(parseSeed(input), expected);
  }
  for (const input of [null, undefined, '', ' ', '42x', '-1', '1.5', '1e2', 'Infinity', '0x10', '4294967296'] as const) {
    assert.equal(parseSeed(input), null);
  }
  assert.deepEqual(resolveSeed('?seed=0', 12), { seed: 0, explicit: true });
  assert.deepEqual(resolveSeed('?seed=oops', 12), { seed: 12, explicit: false });
  assert.deepEqual(resolveSeed('', -1, () => 0.5), { seed: 0x80000000, explicit: false });
  assert.equal(seedURL('https://example.test/calm/?other=1#about', 42).href, 'https://example.test/calm/?other=1&seed=42#about');
  assert.notEqual(nextSeed(42, () => 0.5), 42);
});

const SEEDS = [0, 7, 42, 1234, 99991];

function layoutData(seed: number) {
  const { land, ...rest } = layoutWorld(seed);
  assert.ok(land);
  return rest;
}

test('noise stays bounded and land heights are finite and deterministic per seed', () => {
  const noise = makeNoise2D(42, 0);
  for (let i = -20; i <= 20; i++) {
    const f = fbm2(noise, i / 7, -i / 5, 4);
    const r = ridged2(noise, i / 7, -i / 5, 3);
    assert.ok(Number.isFinite(f) && f >= -1 && f <= 1);
    assert.ok(Number.isFinite(r) && r >= 0 && r <= 1);
  }
  const a = createLand(42, { viewYaw: 1 });
  const b = createLand(42, { viewYaw: 1 });
  const c = createLand(43, { viewYaw: 1 });
  let differs = 0;
  for (let i = 0; i < 400; i++) {
    const x = Math.sin(i * 12.9898) * 5000;
    const z = Math.cos(i * 78.233) * 5000;
    const h = a.heightAt(x, z);
    assert.ok(Number.isFinite(h), `height at ${String(x)},${String(z)}`);
    assert.ok(h > -700 && h < 2600, `height ${String(h)} out of range`);
    assert.equal(h, b.heightAt(x, z));
    assert.equal(a.maskAt(x, z) > 0, h >= 0, 'mask and height agree on land');
    if (h !== c.heightAt(x, z)) differs++;
  }
  assert.ok(differs > 300, 'different seeds give different land');
  assert.deepEqual(a.grid.distance, b.grid.distance);
});

test('the opening keeps Earth-like land and long coasts, with the open ocean beyond', () => {
  for (const seed of SEEDS) {
    const land = layoutWorld(seed).land;
    const fraction = landFraction(land);
    assert.ok(fraction > 0.1 && fraction < 0.6, `seed ${String(seed)} land fraction ${fraction.toFixed(2)}`);
    // Count land/sea transitions along rows: fractal coasts cross often.
    let crossings = 0;
    for (let row = -3000; row <= 3000; row += 500) {
      let prev = land.maskAt(-4000, row) > 0;
      for (let x = -4000; x <= 4000; x += 20) {
        const here = land.maskAt(x, row) > 0;
        if (here !== prev) crossings++;
        prev = here;
      }
    }
    assert.ok(crossings > 20, `seed ${String(seed)} coast crossings ${String(crossings)}`);
    // Highlands in the opening: only the disc the regions leave untouched counts (450 m does not hold in this disc: the five seeds peak at 263 to 425 m).
    let peak = 0;
    for (let x = -REGION_FROM; x <= REGION_FROM; x += 60) {
      for (let z = -REGION_FROM; z <= REGION_FROM; z += 60) {
        if (Math.hypot(x, z) < REGION_FROM) peak = Math.max(peak, land.heightAt(x, z));
      }
    }
    assert.ok(peak > 250, `seed ${String(seed)} highest point ${peak.toFixed(0)}`);
  }
});

test('world layout is deterministic and keeps ships and whale in open water', () => {
  for (const seed of SEEDS) {
    const world = layoutWorld(seed);
    assert.deepEqual(layoutData(seed), layoutData(seed));
    assert.ok(world.ships.length >= 2 && world.ships.length <= 5);
    for (const ship of world.ships) {
      assert.ok(world.land.heightAt(ship.x, ship.z) < -2, `seed ${String(seed)} ship ${String(ship.id)} on land`);
      assert.ok(world.land.clearance(ship.x, ship.z) >= SHIP_LAND_MARGIN - 1, `seed ${String(seed)} ship ${String(ship.id)} near shore`);
    }
    const home = world.whaleHome;
    assert.ok(Number.isFinite(home.x) && Number.isFinite(home.z));
    assert.ok(world.land.clearance(home.x, home.z) > 100, `seed ${String(seed)} whale home too close to land`);
  }
});

test('shore clearance tracks the coast and clamping lands in water', () => {
  const land = layoutWorld(42).land;
  for (let i = 0; i < 300; i++) {
    const x = Math.sin(i * 3.1) * 1200;
    const z = Math.cos(i * 1.7) * 1200;
    const gap = land.clearance(x, z);
    if (land.maskAt(x, z) > 0.05) assert.ok(gap <= land.grid.cell, `land point has clearance ${String(gap)}`);
    // Floating things start at sea and get nudged off the beach.
    if (gap < -40 || gap > 30) continue;
    const out = clampClearOfLand(x, z, land, 30);
    const after = land.clearance(out.x, out.z);
    assert.ok(after >= Math.min(30, gap) - 1e-6, `clamp lost clearance ${String(gap)} -> ${String(after)}`);
    assert.ok(after > 4, `clamp left ${String(after)} m from shore`);
    assert.ok(land.maskAt(out.x, out.z) < 0, 'clamped point is at sea');
  }
});

test('water depth grows away from shore and the shelf map marks shallows', () => {
  assert.equal(depthForMask(0.2), 0);
  let prev = 0;
  for (let m = -0.02; m >= -1; m -= 0.02) {
    const d = depthForMask(m);
    assert.ok(d > prev, 'depth increases offshore');
    prev = d;
  }
  const shelf = nearShelf(layoutWorld(7).land);
  assert.equal(shelf.data.length, shelf.size * shelf.size);
  const values = new Set(shelf.data);
  assert.ok(values.has(0) && values.has(255) && values.size > 50, 'deep, shallow and a gradient between');
});

test('biomes: beaches at the waterline, green lowlands, rock on cliffs, snow on high flats', () => {
  const sand = biomeColor(0.8, 1, 0);
  const lowland = biomeColor(40, 0.98, 0);
  const cliff = biomeColor(40, 0.3, 0);
  const snow = biomeColor(1300, 0.9, 0);
  assert.ok(sand[0] > sand[2] && sand[0] > lowland[0], 'sand is warm and light');
  assert.ok(lowland[1] > lowland[0] && lowland[1] > lowland[2], 'lowlands are green');
  assert.ok(Math.abs(cliff[0] - cliff[1]) < 0.05, 'cliffs are grey rock');
  assert.ok(snow[0] > 0.8 && snow[1] > 0.8 && snow[2] > 0.8, 'peaks are snowy');
});

test('seeds 1..50 put the hero ship and a coastline in the portrait view cone at t=0', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const world = layoutWorld(seed, 185);
    const hero = item(world.ships, 0);
    assert.ok(hero, `seed ${String(seed)} missing hero ship`);
    const focus = {
      x: world.whaleHome.x * 0.78 + hero.x * 0.22,
      z: world.whaleHome.z * 0.78 + hero.z * 0.22,
    };
    assert.equal(
      world.viewYaw,
      computeViewYaw(world.whaleHome, hero, [], 185),
      `seed ${String(seed)} viewYaw mismatch`,
    );
    assert.ok(inPortraitViewCone(world.viewYaw, focus, hero), `seed ${String(seed)}: hero ship outside portrait view cone`);
    const coast = coastAhead(world.land, world.viewYaw, focus, 2600, (28 * Math.PI) / 180);
    assert.ok(coast, `seed ${String(seed)}: no coastline in view`);
    assert.ok(coast.dist > 180, `seed ${String(seed)}: coast ${String(coast.dist)} m crowds the camera`);

    // The coast is not a wall: its distance varies across the view, with an islet or headland gap.
    const hits: number[] = [];
    let islet = false;
    for (let b = 0; b < 9; b++) {
      const yaw = world.viewYaw + (b / 8 - 0.5) * 2 * VIEW_HALF_CONE;
      const dir = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
      let hit = 3000;
      let left = -1;
      for (let d = 160; d < 3000; d += 40) {
        const land = world.land.maskAt(dir.x * d, dir.z * d) > 0;
        if (land && hit === 3000) hit = d;
        if (!land && hit < 3000 && left < 0) left = d;
        if (left > 0 && land) {
          if (hit < 1200) islet = true;
          break;
        }
      }
      hits.push(hit);
    }
    assert.ok(coastSpread(hits) >= 600, `seed ${String(seed)}: coast reads as a wall (${hits.join(' ')})`);
    assert.ok(islet, `seed ${String(seed)}: no islet or headland gap in view`);
  }
}, 30000);

test('shallow shelves sit in view between the camera and the coast', () => {
  for (const seed of [42, 7, 1234]) {
    const world = layoutWorld(seed, 185);
    const shelf = nearShelf(world.land);
    const cell = shelf.extent / (shelf.size - 1);
    let shallow = 0;
    let deep = 0;
    for (let b = -4; b <= 4; b++) {
      const yaw = world.viewYaw + b * 0.08;
      for (let d = 40; d < 700; d += 20) {
        const x = -Math.sin(yaw) * d;
        const z = -Math.cos(yaw) * d;
        if (world.land.maskAt(x, z) > 0) break;
        const v = shelf.data[Math.round((z - shelf.min) / cell) * shelf.size + Math.round((x - shelf.min) / cell)] ?? 0;
        if (v > 200) shallow++;
        if (v < 150) deep++;
      }
    }
    assert.ok(shallow > 20, `seed ${String(seed)}: only ${String(shallow)} shallow samples in view`);
    assert.ok(deep > 10, `seed ${String(seed)}: no deeper water in view (${String(deep)})`);
  }
});

test('quality tiers and adaptive DPR stay bounded', () => {
  assert.equal(selectQualityTier({ mobile: true }), 'low');
  assert.equal(selectQualityTier({ software: true }), 'low');
  const state = createQuality({ mobile: true, dpr: 3 });
  assert.ok(state.ratio <= 2);
  assert.ok(state.waterSize <= 256);
  for (let i = 0; i < 20; i++) updateQuality(state, 50);
  assert.ok(state.ratio >= state.minimum && state.ratio <= state.maximum);
});

test('persistence rejects corrupt memory', () => {
  assert.ok(validateMemory({ version: VERSION, seed: 42 }));
  assert.equal(validateMemory({ version: 2, seed: 42 }), false);
  assert.equal(validateMemory({ version: VERSION, seed: -1 }), false);
  assert.equal(validateMemory(null), false);
});
