import { test } from 'vitest';
import assert from 'node:assert/strict';
import { chunkCoord, chunkKey, chunksAround, createChunkStreamer, parseChunkKey, cellDistance, SHIP_CELL } from '../src/chunks.js';
import { createWorldOrigin, recenterDelta, RECENTER_RADIUS, ORIGIN_SNAP } from '../src/world-origin.js';
import { createLand, type Land } from '../src/land.js';
import { layoutWorld } from '../src/terrain.js';
import { createShipStream, shipSpecsForCell } from '../src/world-ships.js';
import type { ShipSpec } from '../src/terrain.js';
import * as THREE from 'three';
import { createLandStream, selectTiles } from '../src/landmesh.js';
import { createWorld } from '../src/world.js';
import { buildTile, tileSize } from '../src/world-tiles.js';
import { makeNoise2D } from '../src/noise.js';
import { createNavField } from '../src/world-nav.js';
import { waterSignal, SURFACE_BAND } from '../src/seams.js';
import { WHALE_ISLAND_MARGIN, createWhalePilot, shortestAngle, type WhaleCourse } from '../src/whale-course.js';
import { detailFor } from '../src/quality.js';
import { item, last } from '../src/item.js';

test('chunk coordinates floor negatives and boundaries; keys round-trip', () => {
  assert.equal(chunkCoord(0, 512), 0);
  assert.equal(chunkCoord(511.999, 512), 0);
  assert.equal(chunkCoord(512, 512), 1);
  assert.equal(chunkCoord(-0.001, 512), -1);
  assert.equal(chunkCoord(-512, 512), -1);
  assert.equal(chunkCoord(-512.001, 512), -2);
  assert.equal(chunkKey(2, -3, 4), '2:-3:4');
  assert.deepEqual(parseChunkKey(chunkKey(5, -7, 0)), { lod: 5, cx: -7, cz: 0 });
  assert.equal(cellDistance(10, 10, 0, 0, 100), 0);
  assert.equal(cellDistance(-30, 50, 0, 0, 100), 30);
});

test('chunksAround is nearest first and deterministic', () => {
  const a = chunksAround(130, -40, 600, 256);
  assert.deepEqual(a, chunksAround(130, -40, 600, 256));
  assert.equal(a[0], chunkKey(0, 0, -1));
  let prev = -1;
  for (const key of a) {
    const { cx, cz } = parseChunkKey(key);
    const d = cellDistance(130, -40, cx, cz, 256);
    assert.ok(d >= prev && d <= 600);
    prev = d;
  }
  assert.equal(new Set(a).size, a.length);
});

test('chunk streamer loads within budget, keeps a wider ring and unloads behind', () => {
  const built: string[] = [];
  const disposed: string[] = [];
  const streamer = createChunkStreamer<string>({
    wanted: (x, z) => chunksAround(x, z, 300, 256),
    keep: (key, x, z) => {
      const { cx, cz } = parseChunkKey(key);
      return cellDistance(x, z, cx, cz, 256) < 450;
    },
    build: (key) => (built.push(key), key),
    dispose: (_item, key) => disposed.push(key),
    maxBuildsPerFrame: 2,
  });
  streamer.update(0, 0);
  assert.equal(built.length, 2);
  for (let i = 0; i < 20; i++) streamer.update(0, 0);
  const full = streamer.loaded.size;
  assert.equal(full, chunksAround(0, 0, 300, 256).length);
  // Oscillating across a cell boundary never thrashes.
  const before = built.length;
  for (let i = 0; i < 40; i++) streamer.update(i % 2 ? 250 : 262, 0);
  const afterWobble = built.length;
  const disposedWobble = disposed.length;
  for (let i = 0; i < 40; i++) streamer.update(i % 2 ? 250 : 262, 0);
  assert.equal(built.length, afterWobble, 'no rebuilds while wobbling');
  assert.equal(disposed.length, disposedWobble, 'no unloads while wobbling');
  assert.ok(afterWobble - before < 8);
  // Far away everything old unloads.
  for (let i = 0; i < 40; i++) streamer.update(5000, 5000);
  for (const key of chunksAround(0, 0, 300, 256)) assert.ok(!streamer.loaded.has(key));
  assert.ok(disposed.length >= full);
});

test('recenterDelta: nothing inside the radius, snapped moves outside, continuous render positions', () => {
  assert.equal(recenterDelta(0, 0, RECENTER_RADIUS * 0.95, 0), null);
  assert.equal(recenterDelta(0, 0, RECENTER_RADIUS * 0.7, RECENTER_RADIUS * 0.7), null);
  const d = recenterDelta(0, 0, RECENTER_RADIUS + 30, -300);
  assert.ok(d);
  assert.deepEqual(d, { dx: Math.round((RECENTER_RADIUS + 30) / ORIGIN_SNAP) * ORIGIN_SNAP, dz: Math.round(-300 / ORIGIN_SNAP) * ORIGIN_SNAP });
  assert.equal(d.dx % ORIGIN_SNAP, 0);
  const origin = createWorldOrigin();
  const deltas: [number, number][] = [];
  const when: number[] = [];
  let now = 0;
  origin.onRecenter((dx, dz) => {
    deltas.push([dx, dz]);
    when.push(now);
  });
  // A follower kept in render space, shifted by each recentre.
  let renderX = 0;
  origin.onRecenter((dx) => {
    renderX -= dx;
  });
  // Straight along at the top cruise speed (28 m/s), one step per second.
  for (let t = 0; t < 4000; t++) {
    now = t;
    const wx = t * 28;
    const wz = Math.sin(t / 300) * 900;
    renderX = wx - origin.x;
    const beforeX = renderX + origin.x;
    origin.maybeRecenter(wx, wz);
    // World position of the follower is unchanged by a recentre.
    assert.ok(Math.abs(renderX + origin.x - beforeX) < 1e-9);
    assert.ok(Math.hypot(wx - origin.x, wz - origin.z) <= RECENTER_RADIUS);
  }
  assert.ok(deltas.length >= 25, `recentred ${String(deltas.length)} times`);
  // The spec: at most one recentre per 2 minutes at cruise.
  const gaps = when.slice(1).map((t, i) => t - (when[i] ?? 0));
  assert.ok(Math.min(...gaps) >= 120, `shortest gap between recentres ${String(Math.min(...gaps))} s`);
});

/** The first coast along a ray from the start beyond `from` metres: sea, then land a kilometre on. */
function coastAlong(land: { maskAt: (x: number, z: number) => number }, angle: number, from = 40000): [number, number] {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  for (let d = from; d < 1_500_000; d += 500) {
    if (land.maskAt(dx * d, dz * d) < -0.3 && land.maskAt(dx * (d + 1000), dz * (d + 1000)) > 0.3) return [dx * (d + 500), dz * (d + 500)];
  }
  throw new Error(`no coast along ${String(angle)}`);
}

test('land is endless: finite everywhere, coasts and highlands far from the start', () => {
  const land = createLand(42, { viewYaw: 1 });
  let crossings = 0;
  let peak = -Infinity;
  const coasts = [0.3, 2.4, 4.4].map((a) => coastAlong(land, a));
  for (const [cx, cz] of coasts) {
    let prev = land.maskAt(cx - 4000, cz) > 0;
    for (let x = -4000; x <= 4000; x += 25) {
      const here = land.maskAt(cx + x, cz) > 0;
      if (here !== prev) crossings++;
      prev = here;
    }
    for (let i = 0; i < 400; i++) {
      const h = land.heightAt(cx + ((i % 20) - 10) * 600, cz + (Math.floor(i / 20) - 10) * 600);
      assert.ok(Number.isFinite(h));
      peak = Math.max(peak, h);
    }
  }
  // Each line crosses its coast, a few times at most: coasts, not scattered islets.
  assert.ok(crossings >= 3 && crossings <= 30, `coast crossings far out ${String(crossings)}`);
  assert.ok(peak > 200, `highest far point ${peak.toFixed(0)}`);
  // Clearance is valid far away: on land it is negative, out at sea positive.
  let sea = 0;
  let shore = 0;
  const [ax, az] = item(coasts, 0);
  for (let i = 0; i < 60; i++) {
    const x = ax - 3000 + i * 97;
    const c = land.clearance(x, az);
    if (land.maskAt(x, az) > 0.05) assert.ok(c <= land.nav.cell, `land at ${String(x)} has clearance ${String(c)}`);
    if (land.maskAt(x, az) < -0.05) {
      sea++;
      if (c > 0) shore++;
    }
  }
  assert.equal(shore, sea);
});

test('the opening is unchanged: an offset rebuild matches and the start grid agrees with the nav field', () => {
  const world = layoutWorld(7);
  const land = world.land;
  const again = createLand(7, { viewYaw: land.viewYaw, offset: land.offset });
  for (let i = 0; i < 200; i++) {
    const x = Math.sin(i * 1.3) * 3000;
    const z = Math.cos(i * 0.7) * 3000;
    assert.equal(again.heightAt(x, z), land.heightAt(x, z));
  }
  // Within its saturation the tiled nav field equals the start grid's exact distance transform.
  const g = land.grid;
  for (let k = 0; k < 400; k++) {
    const ix = 20 + ((k * 37) % 280);
    const iz = 20 + ((k * 91) % 280);
    const exact = g.distance[iz * g.size + ix] ?? 0;
    if (Math.abs(exact) >= land.nav.saturation) continue;
    const tiled = land.nav.distanceAt(g.min + ix * g.cell, g.min + iz * g.cell);
    assert.ok(Math.abs(tiled - exact) < 1e-3, `texel ${String(ix)},${String(iz)}: ${String(tiled)} vs ${String(exact)}`);
  }
});

test('nav tiles are independent of visit order', () => {
  const land = createLand(11, { viewYaw: 0.4 });
  const a = createNavField(land.maskAt, { min: -1600, cell: 10 });
  const b = createNavField(land.maskAt, { min: -1600, cell: 10 });
  const points = Array.from({ length: 30 }, (_, i) => [8000 + Math.sin(i) * 900, -6000 + Math.cos(i * 2.1) * 900] as const);
  const first = points.map(([x, z]) => a.distanceAt(x, z));
  b.prefetch(8000, -6000, 1200, Infinity);
  const second = [...points].reverse().map(([x, z]) => b.distanceAt(x, z)).reverse();
  assert.deepEqual(first, second);
});

test('a nav prefetch call ends at its budget, not a slice past it', () => {
  const land = createLand(11, { viewYaw: 0.4 });
  // The clock moves only with work: a mask sample costs 4 us, so a row of a 64-sample navigation block costs 0.26 ms.
  let clock = 0;
  const mask = (x: number, z: number) => {
    clock += 0.004;
    return land.maskAt(x, z);
  };
  const field = createNavField(mask, { min: -1600, cell: 10, now: () => clock });
  const budget = 1;
  let calls = 0;
  for (let done = false; !done; calls++) {
    const before = clock;
    done = field.prefetch(8000, -6000, 700, budget);
    assert.ok(clock - before <= budget, `a call spent ${(clock - before).toFixed(2)} ms of ${String(budget)} ms`);
    assert.ok(calls < 100000, 'prefetch finishes');
  }
  assert.ok(calls > 10, 'a small budget spreads the work over many calls');
});

test('only ships within a few hundred metres of the whale sway their sails', () => {
  const ship = (id: number, x: number): ShipSpec => ({ id, x, z: 0, heading: 0.3, scale: 1, kind: 'sloop', seed: id });
  const near = ship(1, 150);
  const far = ship(2, 900);
  const stream = createShipStream({ seed: 1, maskAt: () => 1, startSpecs: [near, far], parent: new THREE.Group(), cap: 8, shoreReady: () => false });
  const open = { clearance: () => 1000, away: () => ({ x: 1, z: 0 }) };
  const sails = (spec: ShipSpec) => {
    const handle = stream.all().find((h) => h.spec.id === spec.id);
    assert.ok(handle, `ship ${String(spec.id)} is afloat`);
    return (item(handle.group.children, 1) as THREE.Mesh).geometry.getAttribute('position').array.slice();
  };
  stream.update(1 / 30, 1, 0, 0, open);
  const before = [near, far].map(sails);
  stream.update(1 / 30, 2.2, 0, 0, open);
  assert.notDeepEqual(sails(near), item(before, 0), 'the near ship\'s cloth moves');
  assert.deepEqual(sails(far), item(before, 1), 'the far ship\'s cloth is left alone');
  assert.equal(stream.stats().visible, 2, 'both ships are still drawn');
  stream.dispose();
});

test('land tiles and ship cells are pure functions of seed and key', () => {
  const land = layoutWorld(42).land;
  const patch = makeNoise2D(42, 21);
  const keys = selectTiles(30000, -20000, new Set(), new Set());
  assert.ok(keys.length > 20);
  // Tiles together cover the stream radius without overlapping.
  let area = 0;
  for (const key of keys) area += tileSize(parseChunkKey(key).lod) ** 2;
  assert.ok(area > Math.PI * 8600 * 8600);
  const pick = keys.filter((_, i) => i % 7 === 0).slice(0, 6);
  const once = pick.map((key) => {
    const { lod, cx, cz } = parseChunkKey(key);
    return buildTile(land, patch, lod, cx, cz, 16);
  });
  const fresh = createLand(42, { viewYaw: land.viewYaw, offset: land.offset });
  const twice = [...pick].reverse().map((key) => {
    const { lod, cx, cz } = parseChunkKey(key);
    return buildTile(fresh, makeNoise2D(42, 21), lod, cx, cz, 16);
  }).reverse();
  assert.deepEqual(once, twice);

  const specs = (seed: number) => {
    const out = [];
    for (let cz = -6; cz <= 6; cz++) for (let cx = -6; cx <= 6; cx++) out.push(...shipSpecsForCell(seed, cx, cz, land.maskAt));
    return out;
  };
  const ships = specs(42);
  assert.deepEqual(ships, specs(42));
  assert.ok(ships.length > 10, `${String(ships.length)} ships`);
  assert.notDeepEqual(ships, specs(43));
  for (const ship of ships) {
    assert.ok(land.maskAt(ship.x, ship.z) < 0, 'ship at sea');
    assert.ok(Math.hypot(ship.x, ship.z) > 1600, 'random ships keep out of the opening');
    const { cx, cz } = { cx: Math.floor(ship.x / SHIP_CELL), cz: Math.floor(ship.z / SHIP_CELL) };
    assert.ok(shipSpecsForCell(42, cx, cz, land.maskAt).some((s) => s.id === ship.id));
  }
});

test('water signal crosses the surface smoothly', () => {
  assert.equal(waterSignal(5).submersion, 0);
  assert.equal(waterSignal(-5).submersion, 1);
  assert.equal(waterSignal(0).submersion, 0.5);
  assert.equal(waterSignal(-SURFACE_BAND * 2).underwater, true);
});

/** Cruising pace the pilot is driven at (m/s); the mover itself supplies it in the app. */
const CRUISE = 22;

function journey(seed: number, dt: number, seconds: number, shore: Land) {
  const world = layoutWorld(seed);
  // As the app starts it: heading for the way out of the start's sea.
  const heading = world.journey;
  const pilot = createWhalePilot(seed, world.whaleHome, heading);
  const course: WhaleCourse = { x: world.whaleHome.x, z: world.whaleHome.z, heading, leg: heading, speed: CRUISE };
  const steps = Math.round(seconds / dt);
  const marks: number[] = [];
  let minClear = Infinity;
  let far = 0;
  let path = 0;
  shore.nav.prefetch(course.x, course.z, 700, Infinity);
  for (let i = 0; i < steps; i++) {
    // The world keeps the navigation tiles around the whale built, as the player does.
    if (i % Math.round(5 / dt) === 0) shore.nav.prefetch(course.x, course.z, 3400, Infinity);
    const prev = course.heading;
    const px = course.x;
    const pz = course.z;
    pilot.step(course, dt, i * dt, shore);
    path += Math.hypot(course.x - px, course.z - pz);
    assert.ok(Math.abs(shortestAngle(prev, course.heading)) <= pilot.params.turnRate * dt + 1e-8, `seed ${String(seed)} turn rate`);
    minClear = Math.min(minClear, shore.clearance(course.x, course.z));
    far = Math.max(far, Math.hypot(course.x - world.whaleHome.x, course.z - world.whaleHome.z));
    if (i % Math.round(300 / dt) === 0) marks.push(Math.hypot(course.x - world.whaleHome.x, course.z - world.whaleHome.z));
  }
  const net = Math.hypot(course.x - world.whaleHome.x, course.z - world.whaleHome.z);
  return { course, net, far, minClear, marks, path };
}

// One test per seed: the ten together took 131 s on untouched main on a four-core machine, over the old 120 s limit
// for all of them, and a seed that hangs now fails by name.
test.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('the whale cruises for 25 minutes, never beaching (seed %i)', (seed) => {
  const land = layoutWorld(seed).land;
  const run = journey(seed, 1 / 30, 1500, land);
  assert.ok(run.net > 0.6 * run.path, `seed ${String(seed)} net ${run.net.toFixed(0)} m over ${run.path.toFixed(0)} m swum`);
  assert.ok(run.far > 15000, `seed ${String(seed)} got ${run.far.toFixed(0)} m from the start`);
  assert.ok(run.minClear >= WHALE_ISLAND_MARGIN - 1e-3, `seed ${String(seed)} came within ${run.minClear.toFixed(1)} m of land`);
}, 120000);

test('the journey is deterministic and close across 30 and 60 fps', () => {
  const land = layoutWorld(3).land;
  const a = journey(3, 1 / 60, 600, land);
  const b = journey(3, 1 / 60, 600, createLand(3, { viewYaw: land.viewYaw, offset: land.offset }));
  assert.equal(a.course.x, b.course.x);
  assert.equal(a.course.z, b.course.z);
  // Beside a coast a one-metre difference can tip a detour either way, so frame rates agree only until the first such choice.
  for (const seed of [4, 5, 6]) {
    const l = layoutWorld(seed).land;
    const early = journey(seed, 1 / 60, 240, l);
    const c = journey(seed, 1 / 30, 240, l);
    const gap = Math.hypot(early.course.x - c.course.x, early.course.z - c.course.z);
    assert.ok(gap < 40, `seed ${String(seed)} frame-rate gap after 4 minutes ${gap.toFixed(1)} m`);
  }
}, 60000);

// Streaming at the whale's fastest pace (28 m/s), on the main-thread builder (one tile per frame).
const FPS = 30;
const FAST = 28;
const streamLand = layoutWorld(42);

function landStreamAt(x: number, z: number) {
  const stream = createLandStream(streamLand.land, { segments: 48, sunDirection: new THREE.Vector3(0.3, 0.6, 0.2), hazeColor: new THREE.Color(0xc8d8e0) });
  stream.prime(x, z);
  return stream;
}

/** A gently winding fast course: speed eases between 7 and 12 m/s, heading drifts. */
function course(seconds: number, from = streamLand.whaleHome, heading = 0.6) {
  const out: { x: number; z: number; vx: number; vz: number }[] = [];
  let { x, z } = from;
  for (let i = 0; i <= seconds * FPS; i++) {
    const t = i / FPS;
    const speed = FAST - 2.5 * (1 + Math.sin(t * 0.07));
    const a = heading + 0.6 * Math.sin(t * 0.011) + 0.25 * Math.sin(t * 0.043);
    const vx = Math.sin(a) * speed;
    const vz = Math.cos(a) * speed;
    out.push({ x, z, vx, vz });
    x += vx / FPS;
    z += vz / FPS;
  }
  return out;
}

test('land tiles ahead are built before the view needs them at 28 m/s', () => {
  const path = course(120);
  const stream = landStreamAt(item(path, 0).x, item(path, 0).z);
  let split = new Set<string>();
  let needed = new Set<string>();
  let late = 0;
  let fresh = 0;
  path.forEach((p, i) => {
    stream.update(p.x, p.z, 1 / FPS, p.vx, p.vz);
    // What the view at the camera itself (no lead) asks for, fine tiles only.
    const next = new Set<string>();
    const now = new Set(selectTiles(p.x, p.z, split, next).filter((key) => parseChunkKey(key).lod <= 1));
    split = next;
    for (const key of now) {
      const c = parseChunkKey(key);
      const s = tileSize(c.lod);
      const ahead = ((c.cx + 0.5) * s - p.x) * p.vx + ((c.cz + 0.5) * s - p.z) * p.vz > 0;
      if (needed.has(key) || !ahead || i < 20 * FPS) continue;
      fresh++;
      if (stream.tileState(key) !== 'on') late++;
    }
    needed = now;
  });
  assert.ok(fresh > 20, `${String(fresh)} tiles came into view`);
  assert.equal(late, 0, `${String(late)}/${String(fresh)} fine tiles were not solid when the view reached them`);
  assert.ok(stream.stats().ready > 0, 'tiles further ahead are held ready');
  stream.dispose();
});

test('land arrivals trickle: few per frame and never on a fixed beat', () => {
  const path = course(90);
  const stream = landStreamAt(item(path, 0).x, item(path, 0).z);
  const done: number[] = [];
  let before = stream.stats();
  path.forEach((p, i) => {
    stream.update(p.x, p.z, 1 / FPS, p.vx, p.vz);
    const after = stream.stats();
    assert.ok(after.tiles - before.tiles <= 2, `frame ${String(i)} placed ${String(after.tiles - before.tiles)} tiles`);
    if (after.completed > before.completed) done.push(i);
    before = after;
  });
  const gaps = done.slice(1).map((f, i) => f - (done[i] ?? 0));
  assert.ok(gaps.length > 30, `${String(gaps.length)} completions`);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  assert.ok(new Set(gaps).size >= 5 && sd / mean > 0.3, `gaps not periodic (cv ${(sd / mean).toFixed(2)})`);
  stream.dispose();
});

test('a 10 minute fast run never shows a hole in the land inside the haze', () => {
  const path = course(600);
  const stream = landStreamAt(item(path, 0).x, item(path, 0).z);
  let holes = 0;
  for (const p of path) {
    stream.update(p.x, p.z, 1 / FPS, p.vx, p.vz);
    if (stream.stats().holes) holes++;
  }
  const end = item(path, path.length - 1);
  assert.ok(Math.hypot(end.x - item(path, 0).x, end.z - item(path, 0).z) > 4000, 'travelled far');
  assert.equal(holes, 0, `${String(holes)} frames with a hole`);
  stream.dispose();
});

test('streamed tiles do not depend on speed or route', () => {
  const end = { x: streamLand.whaleHome.x + 2400, z: streamLand.whaleHome.z + 1800 };
  const settle = (stream: ReturnType<typeof landStreamAt>) => {
    for (let i = 0; i < 40 * FPS; i++) stream.update(end.x, end.z, 1 / FPS);
    const out = new Map<string, number>();
    for (const child of stream.group.children) {
      const mesh = child as THREE.Mesh;
      const pos = mesh.geometry.getAttribute('position').array;
      let sum = 0;
      let extent = 0;
      for (let k = 0; k < pos.length; k += 7) sum += pos[k] ?? 0;
      for (let k = 0; k < pos.length; k += 3) extent = Math.max(extent, pos[k] ?? 0);
      out.set(`${String(mesh.position.x)}:${String(mesh.position.z)}:${String(extent)}`, sum);
    }
    return out;
  };
  const fast = landStreamAt(streamLand.whaleHome.x, streamLand.whaleHome.z);
  for (let i = 0; i <= 250 * FPS; i++) {
    const t = Math.min(1, i / (250 * FPS));
    fast.update(streamLand.whaleHome.x + 2400 * t, streamLand.whaleHome.z + 1800 * t, 1 / FPS, 9.6, 7.2);
  }
  const direct = landStreamAt(end.x, end.z);
  const a = settle(fast);
  const b = settle(direct);
  // Split hysteresis may leave a different mix of levels; every tile both hold is identical.
  const shared = [...b.keys()].filter((key) => a.has(key));
  assert.ok(shared.length > 20 && shared.length > b.size * 0.7, `${String(shared.length)}/${String(b.size)} shared`);
  for (const key of shared) assert.equal(a.get(key), b.get(key), key);
  fast.dispose();
  direct.dispose();
});

test('a fast world update stays within its frame budget and keeps ships and navigation ahead', () => {
  const scene = new THREE.Scene();
  const gray = new THREE.Color(0xc8d8e0);
  const world = createWorld(42, streamLand, scene, {
    sunDirection: new THREE.Vector3(0.3, 0.6, 0.2),
    hazeColor: gray,
    hazeDensity: 0.00026,
    hazeGradient: { angles: [0, 90], colors: [gray, gray] },
    shallowLight: 1,
    waterSize: 64,
    landSegments: 48,
    detail: detailFor('high'),
    mobile: false,
  });
  const camera = new THREE.PerspectiveCamera();
  const path = course(150);
  const ms: number[] = [];
  let navAhead = 0;
  path.forEach((p, i) => {
    world.update(p.x, p.z, camera, 1 / FPS, i / FPS);
    camera.position.set(p.x - world.origin.x - p.vx * 2, 4, p.z - world.origin.z - p.vz * 2);
    if (i > 2 * FPS) ms.push(world.stats()['streamMs'] as number);
    if (i > 10 * FPS && world.land.nav.ready(p.x + p.vx * 30, p.z + p.vz * 30)) navAhead++;
  });
  ms.sort((a, b) => a - b);
  const p95 = ms[Math.floor(ms.length * 0.95)] ?? 0;
  assert.ok(p95 < 4, `p95 streaming ${p95.toFixed(2)} ms`);
  const stats = world.stats();
  assert.equal(stats['coverageMisses'], 0);
  assert.ok(Math.abs((stats['whaleSpeed'] as number) - Math.hypot(last(path).vx, last(path).vz)) < 1);
  assert.ok(navAhead > (path.length - 10 * FPS) * 0.95, 'navigation is built 30 s ahead');
  assert.ok((stats['shipCells'] as number) > 4);
  world.dispose();
});
