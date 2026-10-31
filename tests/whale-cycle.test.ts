import { test } from 'vitest';
import assert from 'node:assert/strict';
import { circleShore } from '../src/shore.js';
import { layoutWorld } from '../src/terrain.js';
import { createSeafloor } from '../src/seafloor.js';
import { BLOWS, DEEPEST_DIVE, DIVE_MAX, VERTICAL_SPEED, createWhaleMover } from '../src/whale-behavior.js';
import { SHALLOW_Y, floorLimit, type WhalePhase } from '../src/whale-motion.js';
import { PLAN_REACH } from '../src/whale-course.js';
import { DIVE_BELOW, DIVE_DWELL, RISE_ABOVE } from '../src/camera.js';

const SEEDS = [0, 7, 42, 1234, 99991];
const OPEN = circleShore([]);
/** Open ocean: a deep floor far below anything the whale does. */
const DEEP = () => -600;
const DT = 1 / 30;

interface Stretch { up: boolean; start: number; end: number; blows: number; deepest: number }

/** Up and under stretches as the chase camera sees them (its dive and rise lines, with its hysteresis). */
function stretches(seed: number, seconds: number, floorAt: (x: number, z: number) => number = DEEP) {
  const mover = createWhaleMover(seed, { x: 0, z: 0 }, 0.4, floorAt);
  const m = mover.motion;
  const out: Stretch[] = [];
  let cur: Stretch = { up: true, start: 0, end: 0, blows: 0, deepest: 0 };
  let prevPhase: WhalePhase = m.phase;
  const ys: number[] = [];
  const phases: WhalePhase[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const t = i * DT;
    mover.step(DT, t, OPEN);
    const y = floorLimit(m.pose.y, m.floor);
    ys.push(y);
    phases.push(m.phase);
    if (m.phase === 'spout' && prevPhase !== 'spout') cur.blows++;
    prevPhase = m.phase;
    cur.deepest = Math.min(cur.deepest, y);
    const up = cur.up ? y > DIVE_BELOW : y > RISE_ABOVE;
    if (up !== cur.up) {
      cur.end = t;
      out.push(cur);
      cur = { up, start: t, end: t, blows: 0, deepest: y };
    }
  }
  // The first stretch starts mid-surfacing and the last is cut off: neither is a whole one.
  return { whole: out.slice(1), ys, phases };
}

test('surfacings last tens of seconds with a string of blows; dives last minutes and go deep', () => {
  const ups: number[] = [];
  const downs: number[] = [];
  for (const seed of SEEDS) {
    // A breach dips under for a moment on its way back up; that is not a dive.
    const { whole } = stretches(seed, 1800);
    const dives = whole.filter((s) => !s.up && s.end - s.start > 6);
    const surfacings = whole.filter((s) => s.up && s.end - s.start > 6);
    assert.ok(dives.length >= 4 && surfacings.length >= 4, `seed ${String(seed)}: ${String(dives.length)} dives, ${String(surfacings.length)} surfacings in 30 min`);
    for (const s of surfacings) {
      const len = s.end - s.start;
      ups.push(len);
      assert.ok(len > 20 && len < 150, `seed ${String(seed)}: surfacing of ${len.toFixed(0)} s at ${s.start.toFixed(0)}`);
      assert.ok(s.blows >= BLOWS[0] - 1, `seed ${String(seed)}: only ${String(s.blows)} blows at ${s.start.toFixed(0)}`);
    }
    for (const d of dives) {
      const len = d.end - d.start;
      downs.push(len);
      // Up to DIVE_MAX before the climb starts, then the climb from as deep as the deepest dive.
      assert.ok(len > 100 && len < DIVE_MAX + -DEEPEST_DIVE / VERTICAL_SPEED + 60, `seed ${String(seed)}: dive of ${len.toFixed(0)} s at ${d.start.toFixed(0)}`);
      // Feeding dives: 100 to 200 m, now and then deeper toward 300 m (the eased descent may stop a little short).
      assert.ok(d.deepest < -90 && d.deepest > DEEPEST_DIVE - 20, `seed ${String(seed)}: dive at ${d.start.toFixed(0)} reached ${d.deepest.toFixed(1)} m`);
    }
  }
  // Varied, not metronomic.
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  assert.ok(spread(ups) > 30 && spread(downs) > 40, `surfacings ${spread(ups).toFixed(0)} s apart at most, dives ${spread(downs).toFixed(0)} s`);
  assert.ok(downs.some((d) => d > 120), `dive lengths ${String(downs.map((d) => d.toFixed(0)))}`);
}, 60000);

test('between blows the whale stays above the camera dive line, and dives sink and climb at an eased, capped rate', () => {
  for (const seed of SEEDS) {
    const { ys, phases } = stretches(seed, 900);
    for (let i = 1; i < ys.length; i++) {
      if (phases[i] === 'roll' || phases[i] === 'surface' || phases[i] === 'spout') assert.ok((ys[i] ?? 0) > DIVE_BELOW + 0.5, `seed ${String(seed)}: ${String(phases[i])} at ${(ys[i] ?? 0).toFixed(2)} m`);
      // Posed stretches (the fluke-up dive, a breach) move faster; the long dive itself never outruns the cap.
      const free = phases[i] === 'deep' && phases[i - 1] === 'deep';
      if (free && (ys[i] ?? 0) < -8) assert.ok(Math.abs((ys[i] ?? 0) - (ys[i - 1] ?? 0)) / DT < VERTICAL_SPEED * 1.25, `seed ${String(seed)}: ${(((ys[i] ?? 0) - (ys[i - 1] ?? 0)) / DT).toFixed(2)} m/s at ${(i * DT).toFixed(1)}`);
      // Vertical acceleration stays gentle outside the breach: eased starts and stops, no snaps.
      if (i > 1 && phases[i] !== 'breach' && phases[i - 1] !== 'breach' && phases[i] !== 'splash') {
        const accel = ((ys[i] ?? 0) - 2 * (ys[i - 1] ?? 0) + (ys[i - 2] ?? 0)) / (DT * DT);
        assert.ok(Math.abs(accel) < 5, `seed ${String(seed)}: vertical acceleration ${accel.toFixed(2)} at ${(i * DT).toFixed(1)} ${String(phases[i - 1])}>${String(phases[i])}`);
      }
    }
  }
}, 60000);

test('over shallow water the whale stays up and keeps breathing instead of diving', () => {
  const { ys, phases } = stretches(42, 400, () => -8);
  const deepest = Math.min(...ys.slice(Math.round(30 / DT)));
  assert.ok(deepest > -6, `dived to ${deepest.toFixed(1)} m over 8 m of water`);
  const spouts = phases.filter((p, i) => p === 'spout' && phases[i - 1] !== 'spout').length;
  assert.ok(spouts >= 10, `${String(spouts)} blows in 400 s`);
});

test('over real coasts the whale never climbs out, keeps the vertical cap and only cuts a dive short for a shoal', () => {
  const dives: number[] = [];
  for (const seed of [3, 7, 42]) {
    // The real mover over the real seafloor and coasts, with navigation tiles prefetched as the page does.
    const layout = layoutWorld(seed);
    const land = layout.land;
    const mover = createWhaleMover(seed, layout.whaleHome, layout.viewYaw - Math.PI / 2, createSeafloor(seed, land).heightAt, layout.journey);
    const m = mover.motion;
    land.nav.prefetch(m.x, m.z, 1100, Infinity);
    let px = m.x;
    let pz = m.z;
    const raw: number[] = [];
    let prev: WhalePhase = m.phase;
    let below = 0;
    let under: number | null = null;
    let lastY = NaN;
    for (let i = 1; i <= Math.round(1200 / DT); i++) {
      const t = i * DT;
      mover.step(DT, t, land);
      if (i % 15 === 0) {
        const k = Math.min(20, (700 * 15 * DT) / Math.max(1e-6, Math.hypot(m.x - px, m.z - pz)));
        land.nav.prefetch(m.x + ((m.x - px) / (15 * DT)) * k, m.z + ((m.z - pz) / (15 * DT)) * k, PLAN_REACH + 700, 4);
        px = m.x;
        pz = m.z;
      }
      const y = floorLimit(m.pose.y, m.floor);
      raw.push(m.pose.y);
      // Free swimming (the long dive, the climb, skimming a shoal): no posed segment drives the height.
      const free = (m.phase === 'swim' || m.phase === 'deep') && (prev === 'swim' || prev === 'deep');
      prev = m.phase;
      // The floor limit on top only ever nudges: the rail has already cleared the floor ahead.
      if (free && Number.isFinite(lastY)) assert.ok(Math.abs(y - lastY) / DT < 2.5, `seed ${String(seed)} at ${t.toFixed(1)}: the floor jolts the body at ${((y - lastY) / DT).toFixed(2)} m/s`);
      lastY = y;
      const n = raw.length;
      if (free && n > 2) {
        const at = `seed ${String(seed)} at ${t.toFixed(1)}`;
        assert.ok(y < SHALLOW_Y + 0.3, `${at}: ${y.toFixed(2)} m, above the surface glide`);
        assert.ok(Math.abs((raw[n - 1] ?? 0) - (raw[n - 2] ?? 0)) / DT <= VERTICAL_SPEED * 1.02, `${at}: climbs at ${(((raw[n - 1] ?? 0) - (raw[n - 2] ?? 0)) / DT).toFixed(2)} m/s`);
        const accel = ((raw[n - 1] ?? 0) - 2 * (raw[n - 2] ?? 0) + (raw[n - 3] ?? 0)) / (DT * DT);
        assert.ok(Math.abs(accel) < 5, `${at}: vertical acceleration ${accel.toFixed(2)}`);
      }
      // Dives as the chase camera sees them.
      if (under === null) {
        below = y < DIVE_BELOW ? below + DT : 0;
        if (below >= DIVE_DWELL) under = t;
      } else if (y > RISE_ABOVE) {
        dives.push(t - under);
        under = null;
      }
    }
  }
  // Before a fluke-up dive the whale looks for room ahead, so a shoal ends no dive within seconds and most run long.
  const sorted = [...dives].sort((a, b) => a - b);
  assert.ok(dives.length >= 8, `${String(dives.length)} dives`);
  assert.ok((sorted[0] ?? 0) > 8 && (sorted[Math.floor(sorted.length / 2)] ?? 0) > 60, `dive lengths ${String(dives.map((d) => d.toFixed(0)))}`);
}, 600000);
