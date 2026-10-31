import { test } from 'vitest';
import assert from 'node:assert/strict';
import { layoutWorld } from '../src/terrain.js';
import { createSeafloor } from '../src/seafloor.js';
import { LIFE_CELL, createHabitat, lifeInCell, sceneryFade, schoolInCell } from '../src/underwater-life.js';

const land = layoutWorld(42, 140).land;
const floor = createSeafloor(42, land);
const habitat = createHabitat(42);

/** A spread of cells around the start bay, near and away from the coast. */
const cells: [number, number][] = [];
for (let cz = -6; cz <= 6; cz += 2) for (let cx = -6; cx <= 6; cx += 2) cells.push([cx, cz]);

test('life per cell is deterministic and independent of visit order', () => {
  const forward = cells.map(([cx, cz]) => lifeInCell(42, cx, cz, floor.heightAt, habitat, 30));
  const backward = [...cells].reverse().map(([cx, cz]) => lifeInCell(42, cx, cz, floor.heightAt, habitat, 30)).reverse();
  assert.deepEqual(forward, backward);
  const all = forward.flat();
  const kinds = new Set(all.map((i) => i.kind));
  assert.ok(all.length > 50 && kinds.size === 3, `${String(all.length)} ${String([...kinds])}`);
  // Lower tiers try fewer candidates: a subset of the same instances.
  const low = lifeInCell(42, 2, 2, floor.heightAt, habitat, 14);
  const high = lifeInCell(42, 2, 2, floor.heightAt, habitat, 30);
  assert.deepEqual(high.slice(0, low.length), low);
});

test('life stays under the surface, on the floor, inside its cell', () => {
  for (const [cx, cz] of cells) {
    for (const inst of lifeInCell(42, cx, cz, floor.heightAt, habitat, 30)) {
      const ground = floor.heightAt(inst.x, inst.z);
      assert.ok(inst.y <= ground && inst.y > ground - 0.5, 'foot on the floor');
      assert.ok(inst.y + inst.height < -1, `${inst.kind} top ${String(inst.y + inst.height)}`);
      assert.ok(Math.floor(inst.x / LIFE_CELL) === cx && Math.floor(inst.z / LIFE_CELL) === cz);
      assert.ok(inst.height > 0 && inst.width > 0);
    }
  }
});

test('fish schools are seeded per cell and clear of floor and surface', () => {
  let found = 0;
  for (let cz = -4; cz <= 4; cz++) {
    for (let cx = -4; cx <= 4; cx++) {
      const a = schoolInCell(42, cx, cz, floor.heightAt);
      assert.deepEqual(a, schoolInCell(42, cx, cz, floor.heightAt));
      if (!a) continue;
      found++;
      assert.ok(a.y + a.spread < -2 && a.y - a.spread > floor.heightAt(a.x, a.z) + 2);
    }
  }
  assert.ok(found > 0);
});

test('scenery fade clears the camera-to-whale corridor and the camera surroundings, and grows in at the edge', () => {
  const cam = { x: 0, y: -8, z: 0 };
  const whale = { x: 0, y: -12, z: 20 };
  const far = 70;
  // On the line between them: hidden. Tall kelp whose stalk crosses the line: hidden too.
  assert.equal(sceneryFade({ x: 0, y: -10, z: 10 }, 0.5, cam, whale, far), 0);
  assert.equal(sceneryFade({ x: 0.5, y: -25, z: 12 }, 18, cam, whale, far), 0);
  // Next to the camera: hidden.
  assert.equal(sceneryFade({ x: 2, y: -9, z: -1 }, 0.5, cam, whale, far), 0);
  // Well off to the side, or behind the whale: fully shown.
  assert.equal(sceneryFade({ x: 15, y: -20, z: 10 }, 1, cam, whale, far), 1);
  assert.equal(sceneryFade({ x: -12, y: -20, z: 34 }, 1, cam, whale, far), 1);
  // Grows in toward the streamed edge, monotonically.
  let prev = 2;
  for (let d = 30; d <= far; d += 1) {
    const f = sceneryFade({ x: -d, y: -20, z: 0 }, 1, cam, whale, far);
    assert.ok(f <= prev + 1e-12);
    prev = f;
  }
  assert.equal(prev, 0);
});
