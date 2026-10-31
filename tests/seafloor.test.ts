import { test } from 'vitest';
import assert from 'node:assert/strict';
import { layoutWorld } from '../src/terrain.js';
import { ABYSS, RELIEF_START, SOFT_DEPTH, createSeafloor, softDepth } from '../src/seafloor.js';
import { FEED_CELL, feedSiteInCell, feedSitesNear } from '../src/feed-sites.js';

const land = layoutWorld(42, 140).land;
const floor = createSeafloor(42, land);

test('seafloor matches the land on land and on the shallow shelf, and is deterministic', () => {
  const again = createSeafloor(42, land);
  let onLand = 0;
  let shelf = 0;
  let relief = 0;
  for (let i = 0; i < 4000; i++) {
    const x = ((i * 7919) % 6000) - 3000;
    const z = ((i * 104729) % 6000) - 3000;
    const base = land.heightAt(x, z);
    const h = floor.heightAt(x, z);
    assert.ok(Number.isFinite(h));
    assert.equal(h, again.heightAt(x, z));
    if (base >= -RELIEF_START) {
      assert.equal(h, base);
      if (base >= 0) onLand++;
      else shelf++;
    } else {
      // Relief never lifts the floor into the shelf band, and deep water stays within sight.
      assert.ok(h < -RELIEF_START + 1e-9 + 0.0, `${String(base)} → ${String(h)}`);
      assert.ok(h > -ABYSS - 3, String(h));
      if (Math.abs(h - softDepth(base)) > 0.5) relief++;
    }
  }
  assert.ok(onLand > 50 && shelf > 5 && relief > 100, `${String(onLand)} ${String(shelf)} ${String(relief)}`);
  // A different seed gives different relief over the same land.
  const other = createSeafloor(7, land);
  let differs = 0;
  for (let i = 0; i < 200; i++) if (other.heightAt(i * 37 - 3000, 2500 - i * 29) !== floor.heightAt(i * 37 - 3000, 2500 - i * 29)) differs++;
  assert.ok(differs > 20);
});

test('soft depth is identity on the shelf, monotonic and bounded below', () => {
  assert.equal(softDepth(-5), -5);
  assert.equal(softDepth(-SOFT_DEPTH), -SOFT_DEPTH);
  let prev = 0;
  for (let h = 0; h > -1000; h -= 0.5) {
    const v = softDepth(h);
    assert.ok(v <= prev + 1e-12 && v >= -ABYSS);
    prev = v;
  }
});

test('feed sites are deterministic, stable, clear of floor and surface, nearest first', () => {
  const a = feedSitesNear(42, 100, -50, 2000, floor.heightAt);
  const b = feedSitesNear(42, 100, -50, 2000, floor.heightAt);
  assert.deepEqual(a, b);
  assert.ok(a.length > 3, String(a.length));
  let prev = -1;
  for (const site of a) {
    const d = Math.hypot(site.x - 100, site.z + 50);
    assert.ok(d >= prev);
    prev = d;
    const ground = floor.heightAt(site.x, site.z);
    assert.ok(site.y + site.radius <= -2 + 1e-9, 'below the surface');
    assert.ok(site.y - site.radius >= ground + 3 - 1e-9, 'above the floor');
    const cx = Math.floor(site.x / FEED_CELL);
    const cz = Math.floor(site.z / FEED_CELL);
    assert.deepEqual(feedSiteInCell(42, cx, cz, floor.heightAt), site, 'stable per cell');
  }
  // Ids are stable from another query position.
  const ids = new Set(feedSitesNear(42, 900, 400, 2000, floor.heightAt).map((s) => s.id));
  assert.ok(a.filter((s) => ids.has(s.id)).length > 0);
});
