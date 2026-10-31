import { test, expect } from 'vitest';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fork } from '../src/rng.js';
import { layoutWorld } from '../src/terrain.js';
import { circleShore, type Circle, type Shore } from '../src/shore.js';
import {
  WHALE_ISLAND_MARGIN,
  WHALE_MAX_TURN_RATE,
  createWhalePilot,
  headingToward,
  planJourney,
  shortestAngle,
  whaleForward,
  type WhaleCourse,
} from '../src/whale-course.js';

const DT = 1 / 60;
const DURATION = 120;
const SEEDS = [0, 7, 42, 1234, 99991];

function initialHeading(seed: number): number {
  return fork(seed, 'whale')() * Math.PI * 2;
}

function simulate(seed: number, shore: Shore, dt = DT, seconds = DURATION) {
  const world = layoutWorld(seed);
  const heading = initialHeading(seed);
  const pilot = createWhalePilot(seed, world.whaleHome, heading);
  const course: WhaleCourse = { x: world.whaleHome.x, z: world.whaleHome.z, heading, leg: heading };
  const steps = Math.round(seconds / dt);
  const xs = new Float64Array(steps);
  const zs = new Float64Array(steps);
  let turned = 0;
  let prev = course.heading;
  let minClear = Infinity;
  for (let i = 0; i < steps; i++) {
    pilot.step(course, dt, i * dt, shore);
    const delta = Math.abs(shortestAngle(prev, course.heading));
    assert.ok(delta <= pilot.params.turnRate * dt + 1e-8, `seed ${String(seed)} turn ${String(delta)} > limit`);
    assert.ok(Number.isFinite(course.heading) && Math.abs(course.heading) <= Math.PI + 1e-8);
    assert.ok(Number.isFinite(course.x) && Number.isFinite(course.z));
    turned += delta;
    prev = course.heading;
    xs[i] = course.x;
    zs[i] = course.z;
    const gap = shore.clearance(course.x, course.z);
    if (gap < minClear) minClear = gap;
    assert.ok(gap >= WHALE_ISLAND_MARGIN - 1e-3, `seed ${String(seed)} came within ${gap.toFixed(1)} m of land`);
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < steps; i++) {
    cx += xs[i] ?? 0;
    cz += zs[i] ?? 0;
    if ((xs[i] ?? 0) < minX) minX = xs[i] ?? 0;
    if ((xs[i] ?? 0) > maxX) maxX = xs[i] ?? 0;
    if ((zs[i] ?? 0) < minZ) minZ = zs[i] ?? 0;
    if ((zs[i] ?? 0) > maxZ) maxZ = zs[i] ?? 0;
  }
  cx /= steps;
  cz /= steps;
  let meanR = 0;
  for (let i = 0; i < steps; i++) meanR += Math.hypot((xs[i] ?? 0) - cx, (zs[i] ?? 0) - cz);
  meanR /= steps;
  let varR = 0;
  for (let i = 0; i < steps; i++) {
    const r = Math.hypot((xs[i] ?? 0) - cx, (zs[i] ?? 0) - cz) - meanR;
    varR += r * r;
  }
  const stdR = Math.sqrt(varR / steps);
  const diagonal = Math.hypot(maxX - minX, maxZ - minZ);
  const endDist = Math.hypot(course.x - world.whaleHome.x, course.z - world.whaleHome.z);
  let maxHome = 0;
  for (let i = 0; i < steps; i++) {
    const d = Math.hypot((xs[i] ?? 0) - world.whaleHome.x, (zs[i] ?? 0) - world.whaleHome.z);
    if (d > maxHome) maxHome = d;
  }
  return { pilot, course, turned, diagonal, endDist, maxHome, meanR, stdR, minClear, world };
}

test('whale mesh heading points the head along whaleForward', () => {
  for (const heading of [0, 0.6, -1.2, Math.PI, -Math.PI / 2]) {
    const group = new THREE.Group();
    group.rotation.order = 'YXZ';
    group.rotation.y = heading;
    const head = new THREE.Vector3(-1, 0, 0).applyQuaternion(group.quaternion);
    const fwd = whaleForward(heading);
    assert.ok(Math.abs(head.x - fwd.x) < 1e-6 && Math.abs(head.z - fwd.z) < 1e-6, `heading ${String(heading)}`);
  }
});

test('whale cruise travels without spinning and stays in open water, for several seeds', () => {
  expect(WHALE_MAX_TURN_RATE).toBeLessThanOrEqual(0.25);
  for (const seed of SEEDS) {
    const world = layoutWorld(seed);
    const stats = simulate(seed, world.land);
    assert.equal(stats.pilot.params.turnRate, WHALE_MAX_TURN_RATE);
    // A few full rotations is ~3 turns. Stay well under that.
    assert.ok(stats.turned < Math.PI * 2 * 2, `seed ${String(seed)} heading travel ${stats.turned.toFixed(2)} rad`);
    // Extent shows a cruise, not a tight orbit around one point.
    assert.ok(stats.diagonal > 50, `seed ${String(seed)} diagonal ${stats.diagonal.toFixed(1)}`);
    // No home leash: the whale is on a journey and keeps going.
    assert.ok(stats.endDist > 120, `seed ${String(seed)} displacement ${stats.endDist.toFixed(1)}`);
    const circular = stats.meanR < 36 && stats.stdR < stats.meanR * 0.12;
    assert.equal(circular, false, `seed ${String(seed)} small circle r=${stats.meanR.toFixed(1)} sd=${stats.stdR.toFixed(2)}`);
    // The opening minutes stay well off the coast.
    assert.ok(stats.minClear > 60, `seed ${String(seed)} closest approach to land ${stats.minClear.toFixed(1)}`);
  }
}, 60000);

test('whale course is deterministic per seed and steps clear of a blocking island', () => {
  const once = simulate(42, layoutWorld(42).land, DT, 30);
  const twice = simulate(42, layoutWorld(42).land, DT, 30);
  assert.equal(once.course.x, twice.course.x);
  assert.equal(once.course.z, twice.course.z);
  assert.equal(once.course.heading, twice.course.heading);

  const home = { x: 0, z: 0 };
  const heading = 0;
  const pilot = createWhalePilot(5, home, heading);
  const course: WhaleCourse = { x: 0, z: 0, heading, leg: heading };
  // Heading 0 faces −X. Park an island on that line.
  const island: Circle = { x: -42, z: 0, radius: 12 };
  const shore = circleShore([island]);
  let min = Infinity;
  const steps = Math.round(50 / DT);
  for (let i = 0; i < steps; i++) {
    const prev = course.heading;
    pilot.step(course, DT, i * DT, shore);
    assert.ok(Math.abs(shortestAngle(prev, course.heading)) <= WHALE_MAX_TURN_RATE * DT + 1e-8);
    const d = Math.hypot(course.x - island.x, course.z - island.z);
    if (d < min) min = d;
  }
  assert.ok(min >= island.radius + WHALE_ISLAND_MARGIN - 1e-4, `island clearance ${String(min)}`);
  assert.ok(Math.hypot(course.x, course.z) > 25, 'still travelled');
});

test('whale cruise stays close across 30fps and 60fps', () => {
  const land = layoutWorld(42).land;
  const a = simulate(42, land, 1 / 60, 90);
  const b = simulate(42, land, 1 / 30, 90);
  const gap = Math.hypot(a.course.x - b.course.x, a.course.z - b.course.z);
  assert.ok(gap < 8, `frame-rate gap ${gap.toFixed(2)}`);
});

test('whale heading for a real coastline turns away and never beaches', () => {
  const land = layoutWorld(7).land;
  // Find open water about 60 m off the coast, facing the land.
  let start: { x: number; z: number } | null = null;
  for (let r = 300; r < 1500 && !start; r += 10) {
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const gap = land.clearance(x, z);
      if (gap > 55 && gap < 65) {
        start = { x, z };
        break;
      }
    }
  }
  assert.ok(start, 'found a start near the coast');
  const away = land.away(start.x, start.z);
  const heading = headingToward(-away.x, -away.z);
  const pilot = createWhalePilot(7, start, heading);
  const course: WhaleCourse = { x: start.x, z: start.z, heading, leg: heading };
  for (let i = 0; i < Math.round(60 / DT); i++) {
    const prev = course.heading;
    pilot.step(course, DT, i * DT, land);
    assert.ok(Math.abs(shortestAngle(prev, course.heading)) <= WHALE_MAX_TURN_RATE * DT + 1e-8);
    assert.ok(land.clearance(course.x, course.z) >= WHALE_ISLAND_MARGIN - 1e-3, 'stayed off the beach');
    assert.ok(land.heightAt(course.x, course.z) < 0, 'stayed in the water');
  }
});

test('a spent target is not chosen again: the plan heads for other water', () => {
  const open = { clearance: () => 1000, away: () => ({ x: 1, z: 0 }) };
  const first = planJourney(0, 0, 0.5, open, new Map());
  assert.ok(first);
  const again = planJourney(0, 0, 0.5, open, new Map(), undefined, [{ x: first.x, z: first.z }]);
  assert.ok(again);
  assert.ok(Math.hypot(again.x - first.x, again.z - first.z) >= 1500, 'the same water was picked again');
});
