import * as THREE from 'three';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { layoutWorld } from '../src/terrain.js';
import { createSeafloor } from '../src/seafloor.js';
import { createLandStream } from '../src/landmesh.js';
import { createShipStream } from '../src/world-ships.js';
import { createWorldOrigin } from '../src/world-origin.js';
import { createWhaleMover, TRAVEL_MAX } from '../src/whale-behavior.js';
import { PLAN_REACH } from '../src/whale-course.js';
import { createBirds } from '../src/birds.js';
import { createWake } from '../src/wake.js';
import { createSky } from '../src/sky.js';
import { createWeather } from '../src/weather.js';
import { createRegionLook } from '../src/region-look.js';
import { swellRate } from '../src/swell.js';
import { FollowCamera } from '../src/camera.js';
import { last } from '../src/item.js';
import { headlessRenderer } from './headless-renderer.js';

/**
 * A long headless journey of the whole step-3 loop without a GPU: the real whale mover over the real world,
 * with the land, navigation and ship streams, birds, wake, day, weather and the chase camera running as
 * the page runs them. Reports the distance made good in each ten minutes, stalls, tile counts and the heap.
 *
 * usage: npx tsx tools/long-journey.ts <hours> <seed> [seed ...]
 */
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;

const hours = Number(process.argv[2] ?? 2);
const seeds = process.argv.slice(3).map(Number);
if (!seeds.length) seeds.push(42, 7);

const DT = 1 / 30;
/** The streams are serviced this many steps apart (twice a second), as the streaming test does. */
const SERVICE = 15;
/** A stall is a five minute stretch that makes good less than this (metres): at cruise it is 6 km or more. */
const STALL = 1500;

for (const seed of seeds) {
  const began = performance.now();
  const layout = layoutWorld(seed);
  const land = layout.land;
  const floor = createSeafloor(seed, land);
  const mover = createWhaleMover(seed, layout.whaleHome, layout.viewYaw - Math.PI / 2, floor.heightAt, layout.journey);
  const m = mover.motion;
  const scene = new THREE.Scene();
  const renderer = headlessRenderer();
  const sky = createSky(seed, renderer, scene);
  sky.setEnvironmentRefresh(true);
  const weather = createWeather(seed, sky.clearCover);
  const regionLook = createRegionLook(land.regions);
  const stream = createLandStream(land, { segments: 48, sunDirection: sky.sunDirection, hazeColor: sky.hazeColor });
  const parent = new THREE.Group();
  const ships = createShipStream({ seed, maskAt: land.maskAt, startSpecs: layout.ships, parent, cap: 8, shoreReady: land.nav.ready });
  const origin = createWorldOrigin();
  const birds = createBirds(seed, 'high');
  const wake = createWake();
  const camera = new THREE.PerspectiveCamera(48, 1.6, 0.5, 12000);
  const rig = new FollowCamera(camera, { groundAt: (x, z) => floor.heightAt(x + origin.x, z + origin.z) });
  let recentres = 0;
  origin.onRecenter((dx, dz) => {
    recentres++;
    rig.shift(dx, dz);
  });
  stream.prime(m.x, m.z);
  land.nav.prefetch(m.x, m.z, 1100, Infinity);

  const windows: number[] = [];
  const heaps: number[] = [];
  const peak = { tiles: 0, navTiles: 0, navBlocks: 0, shipCells: 0, ships: 0, triangles: 0 };
  let px = m.x;
  let pz = m.z;
  let vx: number;
  let vz: number;
  let path = 0;
  let stepX = m.x;
  let stepZ = m.z;
  let swell = 0;
  let mark = { x: m.x, z: m.z };
  const markEvery = 300 / DT;
  const heapEvery = 600 / DT;
  const total = (hours * 3600) / DT;
  const steps = { tick: 0 };
  let tickMs = 0;
  for (let i = 0; i < total; i++) {
    const time = i * DT;
    mover.step(DT, time, land);
    path += Math.hypot(m.x - stepX, m.z - stepZ);
    stepX = m.x;
    stepZ = m.z;
    const t0 = performance.now();
    const w = weather.update(DT, time, regionLook.weights);
    sky.setWeather(w);
    sky.update(DT);
    swell += DT * swellRate(m.speed / TRAVEL_MAX);
    const state = { x: m.x, y: m.pose.y, z: m.z, heading: m.heading, speed: m.speed };
    birds.update(time, m.x, m.z, DT, { x: camera.position.x + origin.x, y: camera.position.y, z: camera.position.z + origin.z }, false);
    wake.update(state, DT);
    rig.setTarget({ x: m.x - origin.x, y: m.pose.y, z: m.z - origin.z, heading: m.heading });
    rig.update(DT, time);
    tickMs += performance.now() - t0;
    steps.tick++;
    if (i % SERVICE === 0) {
      const dt = SERVICE * DT;
      vx = (m.x - px) / dt;
      vz = (m.z - pz) / dt;
      px = m.x;
      pz = m.z;
      regionLook.update(m.x, m.z);
      origin.maybeRecenter(m.x, m.z);
      const k = Math.min(20, 700 / Math.max(1e-6, Math.hypot(vx, vz)));
      const ax = m.x + vx * k;
      const az = m.z + vz * k;
      land.nav.prefetch(ax, az, PLAN_REACH + 700, 4);
      ships.update(dt, swell, m.x, m.z, land, ax, az);
      stream.update(m.x, m.z, dt, vx, vz);
      const s = stream.stats();
      const n = land.nav.stats();
      const f = ships.stats();
      peak.tiles = Math.max(peak.tiles, s.tiles);
      peak.triangles = Math.max(peak.triangles, s.triangles);
      peak.navTiles = Math.max(peak.navTiles, n.tiles);
      peak.navBlocks = Math.max(peak.navBlocks, n.blocks);
      peak.shipCells = Math.max(peak.shipCells, f.cells);
      peak.ships = Math.max(peak.ships, f.ships);
    }
    if (i > 0 && i % markEvery === 0) {
      windows.push(Math.hypot(m.x - mark.x, m.z - mark.z));
      mark = { x: m.x, z: m.z };
    }
    if (i > 0 && i % heapEvery === 0) {
      collect();
      heaps.push(process.memoryUsage().heapUsed / 1e6);
    }
  }
  const stalls = windows.filter((d) => d < STALL);
  let worst = 0;
  let run = 0;
  for (const d of windows) {
    run = d < STALL ? run + 1 : 0;
    worst = Math.max(worst, run);
  }
  const net = Math.hypot(m.x - layout.whaleHome.x, m.z - layout.whaleHome.z);
  const from = Math.min(2, heaps.length - 1);
  const growth = heaps.length > 2 ? last(heaps) - (heaps[from] ?? 0) : 0;
  const slope = heaps.length > 3 ? (last(heaps) - (heaps[from] ?? 0)) / ((heaps.length - 1 - from) * 10) : 0;
  console.log(
    JSON.stringify({
      seed,
      hours,
      path: Math.round(path),
      net: Math.round(net),
      km5min: windows.map((d) => Math.round(d / 100) / 10),
      stalledWindows: stalls.length,
      longestStallMinutes: worst * 5,
      heapMB: heaps.map((h) => Math.round(h * 10) / 10),
      growthMB: Math.round(growth * 10) / 10,
      growthMBper10min: Math.round(slope * 100) / 100,
      recentres,
      peak,
      stepMsMean: Math.round((tickMs / steps.tick) * 1000) / 1000,
      seconds: Math.round((performance.now() - began) / 1000),
    }),
  );
  stream.dispose();
  ships.dispose();
  birds.dispose();
  wake.dispose();
  sky.dispose();
}
