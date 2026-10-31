import { test } from 'vitest';
import assert from 'node:assert/strict';
import { layoutWorld } from '../src/terrain.js';
import { makeNoise2D } from '../src/noise.js';
import { buildTile, MAP_LEVEL, tileCells, tileSize, treesIn } from '../src/world-tiles.js';
import { createLandLife, TOWN_CELL, TREE, WALKER_LEVELS, type Town } from '../src/land-life.js';
import { detailFor } from '../src/quality.js';
import type { Land } from '../src/land.js';
import { item } from '../src/item.js';

const CELLS = 24;

/** FNV-style checksum of the coast mask, and of the heights wherever it is sea, on a 12 km grid. */
function seaChecksum(land: Land): { mask: number; sea: number; seaPoints: number } {
  let mask = 0x811c9dc5;
  let sea = 0x811c9dc5;
  let seaPoints = 0;
  const mix = (h: number, v: number) => Math.imul(h ^ Math.round(v * 1e6), 0x01000193) >>> 0;
  for (let j = -60; j <= 60; j++) {
    for (let i = -60; i <= 60; i++) {
      const m = land.maskAt(i * 97.3, j * 97.3);
      mask = mix(mask, m);
      if (m < 0) {
        sea = mix(sea, land.heightAt(i * 97.3, j * 97.3));
        seaPoints++;
      }
    }
  }
  return { mask, sea, seaPoints };
}

test('land detail leaves the coast mask and every sea height exactly as before', () => {
  // Measured on the Earth-like world before the land detail was merged in (d7d04d5).
  const before: Record<number, ReturnType<typeof seaChecksum>> = {
    1: { mask: 1645216769, sea: 2984753518, seaPoints: 13867 },
    7: { mask: 1049708305, sea: 3848367018, seaPoints: 13110 },
    42: { mask: 2732917278, sea: 1349036100, seaPoints: 13281 },
  };
  for (const [seed, expected] of Object.entries(before)) assert.deepEqual(seaChecksum(layoutWorld(Number(seed)).land), expected, `seed ${seed}`);
});

function townsNear(seed: number, radius: number): Town[] {
  const land = layoutWorld(seed).land;
  const life = createLandLife(land);
  const out: Town[] = [];
  const n = Math.ceil(radius / TOWN_CELL);
  for (let j = -n; j < n; j++) {
    for (let i = -n; i < n; i++) {
      const town = life.town(i, j);
      if (town && Math.hypot(town.x, town.z) < radius) out.push(town);
    }
  }
  return out;
}

test('towns stand on gentle land by the sea, and most seeds have one near the start', () => {
  let near = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const land = layoutWorld(seed).land;
    const towns = townsNear(seed, 6000);
    if (towns.some((t) => Math.hypot(t.x, t.z) < 4000)) near++;
    const out = { cliff: 0 };
    for (const town of towns) {
      assert.ok(town.houses.length >= 6 && town.houses.length <= 18, `seed ${String(seed)}: ${String(town.houses.length)} houses`);
      for (const house of town.houses) {
        assert.ok(land.maskAt(house.x, house.z) > 0, `seed ${String(seed)}: house in the sea`);
        const h = land.surfaceAt(house.x, house.z, 0, out);
        assert.ok(h > 1.5 && out.cliff <= 0.15, `seed ${String(seed)}: house at ${h.toFixed(1)} m, cliff ${out.cliff.toFixed(2)}`);
        const rise = Math.max(...([[4, 0], [-4, 0], [0, 4], [0, -4]] as const).map(([dx, dz]) => Math.abs(land.surfaceAt(house.x + dx, house.z + dz, 0, out) - h)));
        assert.ok(rise <= 3, `seed ${String(seed)}: house on a ${rise.toFixed(1)} m slope`);
      }
    }
  }
  assert.ok(near >= 18, `only ${String(near)} of 24 seeds have a town within 4 km of the start`);
});

/** The finest tile holding the first town near the start of `seed`. */
function townTile(seed: number) {
  const land = layoutWorld(seed).land;
  const town = item(townsNear(seed, 6000), 0);
  const size = tileSize(0);
  return { land, town, ix: Math.floor(town.x / size), iz: Math.floor(town.z / size) };
}

test('tiles with life are deterministic, keep to the cap and fit a 16-bit index', () => {
  const { land, ix, iz } = townTile(42);
  for (const tier of ['low', 'medium', 'high'] as const) {
    const objects = detailFor(tier).objects;
    const build = () => buildTile(land, makeNoise2D(42, 21), 0, ix, iz, CELLS, { life: createLandLife(land), objects });
    const a = build();
    assert.ok(a);
    // Another tile first, so nothing carried between builds can change this one.
    buildTile(land, makeNoise2D(42, 21), 0, ix + 3, iz - 2, CELLS, { life: createLandLife(land), objects });
    const b = build();
    assert.ok(b);
    assert.deepEqual(a.positions, b.positions);
    assert.deepEqual(a.colors, b.colors);
    assert.deepEqual(a.detail, b.detail);
    assert.deepEqual(a.index, b.index);
    assert.deepEqual(a.walkers, b.walkers);
    assert.ok(a.objects > 0 && a.objects <= objects, `${tier}: ${String(a.objects)} objects`);
    assert.ok(a.positions.length / 3 <= 65536, `${tier}: ${String(a.positions.length / 3)} vertices`);
    assert.ok(a.objectTriangles > 0 && a.objectTriangles < a.triangles);
  }
});

test('a bare first-frame tile has exactly the ground of its full build', () => {
  const { land, ix, iz } = townTile(42);
  const bare = buildTile(land, makeNoise2D(42, 21), 0, ix, iz, CELLS);
  assert.ok(bare);
  const full = buildTile(land, makeNoise2D(42, 21), 0, ix, iz, CELLS, { life: createLandLife(land), objects: 110 }, true);
  assert.ok(full);
  // The full build dissolves in over the bare one: the ground must match to the bit, or the two would fight.
  const ground = bare.positions.length;
  assert.deepEqual(full.positions.slice(0, ground), bare.positions);
  assert.deepEqual(full.index.slice(0, bare.index.length), bare.index);
  assert.ok(full.objects > 0 && bare.objects === 0);
  // The finest levels carry no shading maps.
  assert.equal(full.maps, null);
});

test('coarse tiles carry pure shading maps that leave their geometry alone', () => {
  const { land, town } = townTile(42);
  const life = createLandLife(land);
  const level = MAP_LEVEL + 2;
  const [ix, iz] = [Math.floor(town.x / tileSize(level)), Math.floor(town.z / tileSize(level))];
  const build = (maps: boolean) => {
    const tile = buildTile(land, makeNoise2D(42, 21), level, ix, iz, CELLS, { life, objects: 110 }, maps);
    assert.ok(tile);
    return tile;
  };
  const a = build(true);
  const b = build(true);
  const plain = build(false);
  assert.ok(a.maps && b.maps);
  assert.equal(a.maps.size, CELLS * 4);
  assert.equal(a.maps.color.length, a.maps.size * a.maps.size * 4);
  assert.deepEqual(a.maps, b.maps);
  assert.equal(plain.maps, null);
  assert.deepEqual(a.positions, plain.positions);
  assert.deepEqual(a.index, plain.index);
  // Normals are unit length, and the map has relief: lit and shaded texels, ridges and gullies.
  const n = a.maps.normal;
  let steep = 0;
  const cavities = new Set<number>();
  for (let t = 0; t < n.length; t += 4) {
    const v = [n[t] ?? 0, n[t + 1] ?? 0, n[t + 2] ?? 0].map((c) => c / 127.5 - 1);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 0.03);
    if ((v[1] ?? 0) < 0.9) steep++;
    cavities.add((n[t + 3] ?? 0) >> 5);
  }
  assert.ok(steep > 0, 'some slopes');
  assert.ok(cavities.size >= 4, 'ridges and gullies');
  // A tile below the map level has none, even when asked.
  assert.equal(buildTile(land, makeNoise2D(42, 21), MAP_LEVEL - 1, ix, iz, CELLS, undefined, true)?.maps ?? null, null);
});

/** Heights of a tile's top vertices by world position (skirts hang below them, so the highest at a spot is the surface). */
function surfaceHeights(tile: NonNullable<ReturnType<typeof buildTile>>, x0: number, z0: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let v = 0; v < tile.positions.length; v += 3) {
    const key = `${(x0 + (tile.positions[v] ?? 0)).toFixed(2)}:${(z0 + (tile.positions[v + 2] ?? 0)).toFixed(2)}`;
    out.set(key, Math.max(out.get(key) ?? -Infinity, tile.positions[v + 1] ?? 0));
  }
  return out;
}

test('coarse tiles carry a finer grid than the tier, with no vertex their triangles leave unused', () => {
  const { land, town } = townTile(42);
  assert.equal(tileCells(MAP_LEVEL - 1, CELLS), CELLS);
  assert.equal(tileCells(MAP_LEVEL, CELLS), CELLS * 2);
  for (const level of [MAP_LEVEL, MAP_LEVEL + 2]) {
    const [ix, iz] = [Math.floor(town.x / tileSize(level)), Math.floor(town.z / tileSize(level))];
    const fine = buildTile(land, makeNoise2D(42, 21), level, ix, iz, CELLS);
    const plain = buildTile(land, makeNoise2D(42, 21), level, ix, iz, CELLS, undefined, false, false);
    assert.ok(fine && plain);
    assert.ok(fine.triangles > plain.triangles * 2, `level ${String(level)}: ${String(plain.triangles)} → ${String(fine.triangles)} triangles`);
    for (const tile of [fine, plain]) assert.equal(new Set(tile.index).size, tile.positions.length / 3, 'every vertex is drawn');
  }
});

test('the first fine level continues the lattice of the last plain one, so their seam has no step', () => {
  const { land, town } = townTile(42);
  const noise = makeNoise2D(42, 21);
  const level = MAP_LEVEL - 1;
  assert.equal(tileSize(level) / tileCells(level, CELLS), tileSize(level + 1) / tileCells(level + 1, CELLS));
  const [ix, iz] = [Math.floor(town.x / tileSize(level)), Math.floor(town.z / tileSize(level))];
  const near = buildTile(land, noise, level, ix, iz, CELLS);
  const far = buildTile(land, noise, level + 1, Math.floor(ix / 2), Math.floor(iz / 2), CELLS);
  assert.ok(near && far);
  const nearHeights = surfaceHeights(near, ix * tileSize(level), iz * tileSize(level));
  const farHeights = surfaceHeights(far, Math.floor(ix / 2) * tileSize(level + 1), Math.floor(iz / 2) * tileSize(level + 1));
  let shared = 0;
  for (const [key, height] of nearHeights) {
    const other = farHeights.get(key);
    if (other === undefined) continue;
    shared++;
    assert.ok(Math.abs(other - height) < 1e-3, `${key}: ${String(height)} against ${String(other)}`);
  }
  assert.ok(shared > 100, `${String(shared)} shared vertices`);
});

test('people stand in the tile of their town, on its finest levels only', () => {
  const { land, town, ix, iz } = townTile(42);
  const life = createLandLife(land);
  const tile = buildTile(land, makeNoise2D(42, 21), 0, ix, iz, CELLS, { life, objects: 110 });
  assert.ok(tile);
  const size = tileSize(0);
  const inTile = town.people.filter((p) => Math.floor(p.x / size) === ix && Math.floor(p.z / size) === iz);
  assert.ok(inTile.length > 0);
  assert.ok(tile.walkers && tile.walkers.length >= inTile.length * 8);
  const coarse = buildTile(land, makeNoise2D(42, 21), WALKER_LEVELS, Math.floor(ix / 2 ** WALKER_LEVELS), Math.floor(iz / 2 ** WALKER_LEVELS), CELLS, { life, objects: 110 });
  assert.equal(coarse?.walkers ?? null, null);
});

test('a coarse tile holds a sparser subset of its children’s trees, and trees keep their biome rules', () => {
  const land = layoutWorld(42).land;
  const life = createLandLife(land);
  const out = { cliff: 0 };
  const ground = (x0: number, z0: number) => (lx: number, lz: number) => {
    const h = land.surfaceAt(x0 + lx, z0 + lz, 0, out);
    const e = 2;
    const nx = land.surfaceAt(x0 + lx - e, z0 + lz, 0, { cliff: 0 }) - land.surfaceAt(x0 + lx + e, z0 + lz, 0, { cliff: 0 });
    const nz = land.surfaceAt(x0 + lx, z0 + lz - e, 0, { cliff: 0 }) - land.surfaceAt(x0 + lx, z0 + lz + e, 0, { cliff: 0 });
    return { h, ny: 2 * e / Math.hypot(nx, 2 * e, nz), cliff: out.cliff };
  };
  const { ix, iz } = townTile(42);
  const px = Math.floor(ix / 2);
  const pz = Math.floor(iz / 2);
  const size = tileSize(1);
  const biome = life.biome(land.regions.weightsAt(px * size + size / 2, pz * size + size / 2));
  const parent = treesIn(life, biome, 1, px * size, pz * size, size, [], ground(px * size, pz * size));
  const children = [0, 1].flatMap((a) => [0, 1].flatMap((b) => {
    const x0 = (px * 2 + a) * tileSize(0);
    const z0 = (pz * 2 + b) * tileSize(0);
    return treesIn(life, biome, 0, x0, z0, tileSize(0), [], ground(x0, z0));
  }));
  assert.ok(parent.length > 0 && children.length > parent.length, `${String(parent.length)} → ${String(children.length)}`);
  const kept = parent.filter((t) => children.some((c) => c.x === t.x && c.z === t.z)).length;
  assert.ok(kept >= parent.length * 0.95, `${String(kept)} of ${String(parent.length)} parent trees stay`);
  for (const tree of children) {
    assert.ok(tree.h >= 1.2, 'no tree in the sea or at the waterline');
    if (tree.kind === TREE.palm) assert.ok(biome.tropical > 0, 'palms only in the tropics');
    if (tree.kind !== TREE.boulder) assert.ok(tree.h < Math.max(biome.treeline * 1.3, 20), 'no trees above the treeline');
  }
});
