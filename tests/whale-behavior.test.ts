import { test } from 'vitest';
import assert from 'node:assert/strict';
import { layoutWorld } from '../src/terrain.js';
import { circleShore, type Shore } from '../src/shore.js';
import { FEED_CELL, feedSiteInCell, feedSitesNear } from '../src/feed-sites.js';
import { BREATH_PACE, DEEPEST_DIVE, DIVE_MAX, MAX_ACCEL, MAX_DECEL, TRAVEL_MAX, TRAVEL_MIN, VERTICAL_SPEED, createWhaleMover, type WhaleBehavior } from '../src/whale-behavior.js';
import { WHALE_ISLAND_MARGIN, WHALE_MAX_TURN_RATE, shortestAngle } from '../src/whale-course.js';
import { BREACH_SURGE, FLOOR_CLEARANCE, floorLimit, type WhalePhase } from '../src/whale-motion.js';
import { item, last } from '../src/item.js';

const SEEDS = [0, 7, 42, 1234, 99991];
const OPEN = circleShore([]);
/** Rolling deep seafloor (−190 … −310 m, slopes of a few degrees): deep krill swarms everywhere, and ridges for the floor limit. */
const ROLLING = (x: number, z: number) => -250 + 60 * Math.sin(x / 1000) * Math.cos(z / 1100);

interface Sample {
  t: number;
  x: number;
  z: number;
  /** Body height as whale.update composes it (pose, then floor limit; bob left out). */
  y: number;
  floor: number | undefined;
  pitch: number;
  heading: number;
  speed: number;
  surge: number;
  behavior: WhaleBehavior;
  phase: WhalePhase;
  site: { id: number; x: number; y: number; z: number; radius: number } | null;
}

function run(seed: number, shore: Shore, floorAt: ((x: number, z: number) => number) | undefined, seconds: number, dt = 1 / 30, home = { x: 0, z: 0 }) {
  const mover = createWhaleMover(seed, home, 0.4, floorAt);
  const out: Sample[] = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const t = i * dt;
    mover.step(dt, t, shore);
    const m = mover.motion;
    out.push({
      t,
      x: m.x,
      z: m.z,
      y: floorLimit(m.pose.y, m.floor),
      floor: m.floor,
      pitch: m.pose.pitch,
      heading: m.heading,
      speed: m.speed,
      surge: m.pose.surge,
      behavior: m.behavior,
      phase: m.phase,
      site: m.site,
    });
  }
  return { samples: out, mover };
}

const std = (xs: number[]) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
};

test('speed varies smoothly within bounds, deterministic per seed and close across frame rates', () => {
  for (const seed of SEEDS) {
    const { samples } = run(seed, OPEN, ROLLING, 300);
    for (let i = 0; i < samples.length; i++) {
      const s = item(samples, i);
      assert.ok(s.speed >= 0 && s.speed <= TRAVEL_MAX + BREACH_SURGE + 1e-6, `seed ${String(seed)} speed ${String(s.speed)}`);
      if (i === 0) continue;
      const accel = (s.speed - s.surge - (item(samples, i - 1).speed - item(samples, i - 1).surge)) * 30;
      assert.ok(accel <= MAX_ACCEL + 1e-6 && accel >= -MAX_DECEL - 1e-6, `seed ${String(seed)} accel ${String(accel)} at ${String(s.t)}`);
    }
    const sd = std(samples.map((s) => s.speed));
    assert.ok(sd > 1, `seed ${String(seed)} speed std-dev ${sd.toFixed(2)}`);
    const travel = samples.filter((s) => s.behavior === 'travel').map((s) => s.speed);
    assert.ok(Math.max(...travel) > TRAVEL_MAX - 3 && Math.min(...travel.slice(300)) < TRAVEL_MIN + 4, `seed ${String(seed)} stays at one speed`);
  }
  const a = run(42, OPEN, ROLLING, 120).samples;
  assert.deepEqual(a, run(42, OPEN, ROLLING, 120).samples);
  const b = run(42, OPEN, ROLLING, 120, 1 / 60).samples;
  for (let i = 0; i < a.length; i += 300) {
    const j = Math.min(b.length - 1, i * 2);
    assert.ok(Math.abs(item(a, i).speed - item(b, j).speed) < 0.3, `30 vs 60 fps speed at ${String(item(a, i).t)}`);
  }
  const gap = Math.hypot(last(a).x - last(b).x, last(a).z - last(b).z);
  assert.ok(gap < 10, `30 vs 60 fps gap ${gap.toFixed(2)} m`);
});

test('the whale surfaces regularly at a glide, feeds at a site within ten minutes and resumes travel', () => {
  for (const seed of SEEDS) {
    const { samples } = run(seed, OPEN, ROLLING, 1500);
    // Surfacing: blows come in strings a roll apart; every string starts within the bound after the previous one
    // (a surfacing of up to about two minutes, then a long dive of up to DIVE_MAX and its climb from the deepest dive).
    const starts = samples.filter((s, i) => i > 0 && s.phase === 'spout' && item(samples, i - 1).phase !== 'spout').map((s) => s.t);
    const breaths = starts.filter((t, i) => i === 0 || t - (starts[i - 1] ?? 0) > 30);
    assert.ok(breaths.length >= 3, `seed ${String(seed)}: ${String(breaths.length)} surfacings in 25 min`);
    for (let i = 1; i < breaths.length; i++) assert.ok((breaths[i] ?? 0) - (breaths[i - 1] ?? 0) < DIVE_MAX + -DEEPEST_DIVE / VERTICAL_SPEED + 150, `seed ${String(seed)} surfacing gap ${String((breaths[i] ?? 0) - (breaths[i - 1] ?? 0))}`);
    const gaps = breaths.slice(1).map((t, i) => t - (breaths[i] ?? 0));
    assert.ok(Math.max(...gaps) - Math.min(...gaps) > 5, `seed ${String(seed)}: breaths are metronomic ${String(gaps)}`);

    // A breath is a glide: the spout comes at well over half the cruising floor, never at a stop.
    for (const s of samples) if (s.phase === 'spout' && s.t > 30) assert.ok(s.speed > BREATH_PACE * TRAVEL_MIN * 0.8, `seed ${String(seed)}: spout at ${s.speed.toFixed(1)} m/s`);

    // Feeding: starts within 10 minutes, gets inside the swarm, and the whale travels on afterwards.
    const first = samples.findIndex((s) => s.behavior === 'feed');
    assert.ok(first >= 0 && item(samples, first).t < 600, `seed ${String(seed)}: no feed in 10 min`);
    const site = item(samples, first).site;
    assert.ok(site);
    const during = samples.filter((s) => s.site?.id === site.id);
    const closest = Math.min(...during.map((s) => Math.hypot(s.x - site.x, s.y - site.y, s.z - site.z)));
    assert.ok(closest < site.radius, `seed ${String(seed)}: closest ${closest.toFixed(1)} m to a ${site.radius.toFixed(1)} m swarm`);
    const end = samples.findIndex((s, i) => i > first && s.behavior !== 'feed');
    assert.ok(end > 0 && item(samples, end).behavior !== 'feed', `seed ${String(seed)}: feed never ended`);
    assert.ok(samples.slice(end).some((s) => s.behavior === 'travel' && s.speed > TRAVEL_MIN), `seed ${String(seed)}: did not resume travel`);
  }
});

test('feeding is rare and brief over an hour', () => {
  for (const seed of SEEDS) {
    const { samples } = run(seed, OPEN, ROLLING, 3600, 1 / 15);
    const starts = samples.filter((s, i) => s.behavior === 'feed' && samples[i - 1]?.behavior !== 'feed').map((s) => s.t);
    for (let i = 1; i < starts.length; i++) assert.ok((starts[i] ?? 0) - (starts[i - 1] ?? 0) >= 480, `seed ${String(seed)}: feeds ${String((starts[i] ?? 0) - (starts[i - 1] ?? 0))} s apart`);
    const share = samples.filter((s) => s.behavior === 'feed').length / samples.length;
    // The approach includes the descent to a swarm 80 to 200 m down, so a feed takes a couple of minutes.
    assert.ok(share < 0.15, `seed ${String(seed)}: feeding ${(100 * share).toFixed(0)} percent of the hour`);
  }
}, 60000);

test('every transition is continuous in height, pitch and heading, including a forced review', () => {
  for (const seed of SEEDS) {
    const dt = 1 / 30;
    const mover = createWhaleMover(seed, { x: 0, z: 0 }, 0.4, ROLLING);
    let prev = { y: 0, pitch: 0, heading: 0, phase: 'surface' as WhalePhase };
    const seen = new Set<string>();
    for (let i = 0; i < Math.round(600 / dt); i++) {
      const t = i * dt;
      if (i === 9000) mover.force('deep', 0.3);
      mover.step(dt, t, OPEN);
      const m = mover.motion;
      const y = floorLimit(m.pose.y, m.floor);
      seen.add(`${prev.phase}>${m.phase}`);
      if (i > 0 && i !== 9000) {
        // The breach flight is the one fast move (its ballistic arc is checked in whale-model tests).
        const flying = m.phase === 'breach' || prev.phase === 'breach';
        assert.ok(Math.abs(y - prev.y) < (flying ? 0.4 : 0.12), `seed ${String(seed)} Δy ${(y - prev.y).toFixed(3)} at ${t.toFixed(2)} ${prev.phase}>${m.phase}`);
        assert.ok(Math.abs(m.pose.pitch - prev.pitch) < (flying ? 0.1 : 0.035), `seed ${String(seed)} Δpitch at ${t.toFixed(2)} ${prev.phase}>${m.phase}`);
        assert.ok(Math.abs(shortestAngle(prev.heading, m.heading)) <= WHALE_MAX_TURN_RATE * dt + 1e-9, `seed ${String(seed)} Δheading at ${String(t)}`);
      }
      prev = { y, pitch: m.pose.pitch, heading: m.heading, phase: m.phase };
    }
    for (const edge of ['surface>spout', 'spout>roll', 'roll>surface', 'spout>dive', 'dive>deep', 'swim>surface']) assert.ok(seen.has(edge) || seen.has(edge.replace('deep', 'swim')), `seed ${String(seed)} never ${edge}`);
  }
});

test('the journey covers ground fast, never beaches and keeps clear of the floor', () => {
  for (const seed of SEEDS) {
    const world = layoutWorld(seed);
    const land = world.land;
    const { samples } = run(seed, land, (x, z) => land.heightAt(x, z), 600, 1 / 30, world.whaleHome);
    const reach = Math.max(...samples.map((s) => Math.hypot(s.x - world.whaleHome.x, s.z - world.whaleHome.z)));
    // The old cruise managed at most ~1.1 km in ten minutes; the start seas are enclosed, so range is what counts.
    assert.ok(reach > 1000, `seed ${String(seed)} got ${reach.toFixed(0)} m from the start`);
    for (const s of samples) {
      assert.ok(land.clearance(s.x, s.z) >= WHALE_ISLAND_MARGIN - 1e-3 && land.heightAt(s.x, s.z) < 0, `seed ${String(seed)} on land at ${String(s.t)}`);
      assert.ok(s.floor === undefined || s.y >= s.floor + FLOOR_CLEARANCE - 1e-6 || s.y >= -2.81, `seed ${String(seed)} floor at ${String(s.t)}`);
    }
  }
  for (const seed of SEEDS) {
    const { samples } = run(seed, OPEN, ROLLING, 400);
    for (const s of samples) assert.ok(s.y >= ROLLING(s.x, s.z) + FLOOR_CLEARANCE - 1e-6, `seed ${String(seed)} floor clearance at ${String(s.t)}`);
    const path = samples.reduce((sum, s, i) => (i ? sum + Math.hypot(s.x - item(samples, i - 1).x, s.z - item(samples, i - 1).z) : 0), 0);
    assert.ok(path > 1500, `seed ${String(seed)} swam only ${path.toFixed(0)} m in 400 s`);
  }
}, 60000);

test('feed sites are pure, stable and clear of floor and surface', () => {
  const floors = [ROLLING, () => -200, () => -12, (x: number) => -5 - x / 100];
  for (const floorAt of floors) {
    for (const seed of [1, 42, 777]) {
      const a = feedSitesNear(seed, 900, -300, 1800, floorAt);
      assert.deepEqual(a, feedSitesNear(seed, 900, -300, 1800, floorAt));
      for (let i = 1; i < a.length; i++) {
        assert.ok(Math.hypot(item(a, i).x - 900, item(a, i).z + 300) >= Math.hypot(item(a, i - 1).x - 900, item(a, i - 1).z + 300), 'nearest first');
      }
      for (const s of a) {
        const cx = Math.floor(s.x / FEED_CELL);
        const cz = Math.floor(s.z / FEED_CELL);
        assert.deepEqual(feedSiteInCell(seed, cx, cz, floorAt), s, 'same site from its cell');
        const floor = floorAt(s.x, s.z);
        assert.ok(s.y <= -s.radius - 2 + 1e-9, `site top ${String(s.y + s.radius)} too near the surface`);
        assert.ok(s.y - s.radius >= floor + 3 - 1e-9, `site bottom ${String(s.y - s.radius)} too near the floor ${String(floor)}`);
      }
    }
  }
  assert.equal(feedSitesNear(5, 0, 0, 3000, () => -12).length, 0, 'shallow water holds no sites');
  assert.ok(feedSitesNear(5, 0, 0, 3000, () => -200).length > 20, 'deep water holds plenty');
  const ids = new Set(feedSitesNear(9, 0, 0, 3000, () => -200).map((s) => s.id));
  assert.ok(ids.size > 20, 'ids are distinct');
});
