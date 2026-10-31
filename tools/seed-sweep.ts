import { layoutWorld } from '../src/terrain.js';
import { createLand, type Land } from '../src/land.js';
import { createSeafloor } from '../src/seafloor.js';
import { createWhaleMover } from '../src/whale-behavior.js';
import { PLAN_REACH } from '../src/whale-course.js';
import { last } from '../src/item.js';

/**
 * Route gate over many seeds: the real whale mover for an hour on each, with the navigation tiles prefetched as the
 * page does. Reports the net distance, net over path and the five-minute windows that make under 1.5 km good, and
 * fails when a seed's net over path is under 0.5 or any ten minutes (sliding by a minute) make under 2 km good; it reports the seeds that dip under 1.5 km in five minutes.
 *
 * usage: npx tsx tools/seed-sweep.ts [first seed] [last seed] [minutes]    (defaults: 1 24 60)
 *        npx tsx tools/seed-sweep.ts 42,7,1234 - [minutes]    (a list of seeds)
 */
const list = process.argv[2]?.includes(',') ? process.argv[2].split(',').map(Number) : null;
const first = list ? list[0] ?? 0 : Number(process.argv[2] ?? 1);
const lastSeed = list ? last(list) : Number(process.argv[3] ?? 24);
const minutes = Number(process.argv[4] ?? 60);
const seeds = list ?? Array.from({ length: lastSeed - first + 1 }, (_, k) => first + k);
const DT = 1 / 30;
const MIN_RATIO = 0.5;
const STALL = 1500;
const STALL_TEN = 2000;
/** Natural land this close (m) counts as a coast in view: the land haze starts to hide it at 6.2 km. */
const COAST_VIEW = 6000;

/** Whether natural land lies within `reach`, sampled on rings like the page's debug probe. */
function coastNear(land: Land, x: number, z: number, reach: number): boolean {
  for (let d = 250; d <= reach; d += 250) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      if (land.maskAt(x + Math.cos(a) * d, z + Math.sin(a) * d) > 0) return true;
    }
  }
  return false;
}

const rows: { seed: number; net: number; ratio: number; stalled: number; longest: number; slowest: number; at: number; slowTen: number; coast: number; open: number }[] = [];
for (const seed of seeds) {
  const layout = layoutWorld(seed);
  const land = layout.land;
  const natural = createLand(seed, { viewYaw: layout.viewYaw, offset: land.offset, landmarks: false });
  let coastSamples = 0;
  let samples = 0;
  let openRun = 0;
  let open = 0;
  const mover = createWhaleMover(seed, layout.whaleHome, layout.viewYaw - Math.PI / 2, createSeafloor(seed, land).heightAt, layout.journey);
  const m = mover.motion;
  land.nav.prefetch(m.x, m.z, 1100, Infinity);
  let path = 0;
  let px = m.x;
  let pz = m.z;
  let mark = { x: m.x, z: m.z };
  let vx: number;
  let vz: number;
  let stalled = 0;
  let net10 = 0;
  let run = 0;
  let longest = 0;
  const fixes: number[] = [];
  const detail: string[] = [];
  for (let i = 1; i <= (minutes * 60) / DT; i++) {
    mover.step(DT, i * DT, land);
    path += Math.hypot(m.x - px, m.z - pz);
    if (i % 15 === 0) {
      vx = (m.x - px) / (15 * DT);
      vz = (m.z - pz) / (15 * DT);
      const k = Math.min(20, 700 / Math.max(1e-6, Math.hypot(vx, vz)));
      land.nav.prefetch(m.x + vx * k, m.z + vz * k, PLAN_REACH + 700, 4);
    }
    px = m.x;
    pz = m.z;
    if (i % (10 / DT) === 0) {
      const near = coastNear(natural, m.x, m.z, COAST_VIEW);
      samples++;
      coastSamples += near ? 1 : 0;
      openRun = near ? 0 : openRun + 10;
      open = Math.max(open, openRun);
    }
    if (i === Math.round(600 / DT)) net10 = Math.hypot(m.x - layout.whaleHome.x, m.z - layout.whaleHome.z);
    if (i % (60 / DT) === 0) fixes.push(m.x, m.z);
    if (process.env['SWEEP_TRACE'] && i % (10 / DT) === 0) detail.push(`${String(Math.round(i * DT))}s ${m.behavior} ${m.phase} x ${String(Math.round(m.x))} z ${String(Math.round(m.z))} hd ${m.heading.toFixed(2)} sp ${m.speed.toFixed(0)} clear ${String(Math.round(land.clearance(m.x, m.z)))} far ${String(mover.course.far?.toFixed(2))} plan ${String(mover.course.plan?.toFixed(2))} leg ${mover.course.leg.toFixed(2)} esc ${mover.course.escape && i * DT < mover.course.escape.until ? mover.course.escape.heading.toFixed(2) : '-'} aim ${mover.course.aim ? 'y' : '-'}`);
    if (i % (300 / DT) === 0) {
      const slow = Math.hypot(m.x - mark.x, m.z - mark.z) < STALL;
      stalled += slow ? 1 : 0;
      run = slow ? run + 1 : 0;
      longest = Math.max(longest, run * 5);
      mark = { x: m.x, z: m.z };
    }
  }
  const net = Math.hypot(m.x - layout.whaleHome.x, m.z - layout.whaleHome.z);
  // The worst five minutes anywhere, in windows that slide a minute at a time.
  let slowest = Infinity;
  let at = 0;
  for (let k = 5; k < fixes.length / 2; k++) {
    const d = Math.hypot((fixes[2 * k] ?? 0) - (fixes[2 * (k - 5)] ?? 0), (fixes[2 * k + 1] ?? 0) - (fixes[2 * (k - 5) + 1] ?? 0));
    if (d < slowest) {
      slowest = d;
      at = k - 5;
    }
  }
  if (process.env['SWEEP_TRACE']) {
    for (let k = Math.max(0, at * 6 - 6); k <= Math.min(detail.length - 1, at * 6 + 36); k++) console.log(`  ${String(detail[k])}`);
  }
  if (process.env['SWEEP_KM']) console.log(`  km each five minutes: ${Array.from({ length: Math.floor(fixes.length / 2 / 5) }, (_, w) => (Math.hypot((fixes[2 * (5 * w + 5) ] ?? 0) - (fixes[2 * 5 * w] ?? 0), (fixes[2 * (5 * w + 5) + 1] ?? 0) - (fixes[2 * 5 * w + 1] ?? 0)) / 1000).toFixed(1)).join(' ')}`);
  let slowTen = Infinity;
  for (let k = 10; k < fixes.length / 2; k++) slowTen = Math.min(slowTen, Math.hypot((fixes[2 * k] ?? 0) - (fixes[2 * (k - 10)] ?? 0), (fixes[2 * k + 1] ?? 0) - (fixes[2 * (k - 10) + 1] ?? 0)));
  const coast = coastSamples / samples;
  rows.push({ seed, net, ratio: net / path, stalled, longest, slowest, at, slowTen, coast, open });
  console.log(`seed ${String(seed)}: net ${(net / 1000).toFixed(1)} km, net/path ${(net / path).toFixed(2)}, coast in view ${(100 * coast).toFixed(0)}%, longest open ${String(Math.round(open / 60))} min, ${String(stalled)} stalled 5-minute windows, longest ${String(longest)} min, worst five minutes ${(slowest / 1000).toFixed(1)} km (from minute ${String(at)}), worst ten ${(slowTen / 1000).toFixed(1)} km, net in 10 min ${(net10 / 1000).toFixed(1)} km`);
}
const worst = rows.reduce((a, b) => (b.ratio < a.ratio ? b : a));
const mean = rows.reduce((s, r) => s + r.net, 0) / rows.length;
const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
const shares = rows.map((r) => r.coast).sort((a, b) => a - b);
console.log(`seeds ${list ? list.join(',') : `${String(first)}-${String(lastSeed)}`}, ${String(minutes)} min: mean net ${(mean / 1000).toFixed(1)} km, median net/path ${(ratios[ratios.length >> 1] ?? 0).toFixed(2)}, coast in view ${(100 * (shares[0] ?? 0)).toFixed(0)} to ${(100 * last(shares)).toFixed(0)}% (median ${(100 * (shares[shares.length >> 1] ?? 0)).toFixed(0)}%, mean ${((100 * shares.reduce((a, b) => a + b, 0)) / shares.length).toFixed(0)}%), worst net/path ${worst.ratio.toFixed(2)} (seed ${String(worst.seed)}), worst five minutes ${(Math.min(...rows.map((r) => r.slowest)) / 1000).toFixed(1)} km, worst ten ${(Math.min(...rows.map((r) => r.slowTen)) / 1000).toFixed(1)} km, ${String(rows.filter((r) => r.slowest < STALL).length)} of ${String(rows.length)} seeds dip under ${String(STALL / 1000)} km in five minutes`);
if (worst.ratio < MIN_RATIO) {
  console.error(`seed ${String(worst.seed)} makes ${worst.ratio.toFixed(2)} net over path, under ${String(MIN_RATIO)}`);
  process.exitCode = 1;
}
// A seed may dip once (a U-turn out of a gulf); no ten minutes may make under 2 km good.
const slow = rows.find((r) => r.slowTen < STALL_TEN);
if (slow) {
  console.error(`seed ${String(slow.seed)} makes only ${(slow.slowTen / 1000).toFixed(1)} km in ten minutes`);
  process.exitCode = 1;
}
