import { test } from 'vitest';
import * as THREE from 'three';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { layoutWorld } from '../src/terrain.js';
import { createLandStream } from '../src/landmesh.js';
import { createShipStream } from '../src/world-ships.js';
import { OPENING_NAV_RADIUS, PLAN_REACH, createWhalePilot, type WhaleCourse } from '../src/whale-course.js';
import { createWorldOrigin } from '../src/world-origin.js';

setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;

const DT = 1 / 30;
/** The stream is serviced twice a second: the main-thread builder is slower than the worker, so this only has to keep counts bounded. */
const SERVICE = 15;
const CRUISE = 22;

test('an hour of travel keeps tiles, navigation blocks, ship cells and caches inside their caps', () => {
  const layout = layoutWorld(42);
  const land = layout.land;
  const heading = layout.journey;
  const pilot = createWhalePilot(42, layout.whaleHome, heading);
  const course: WhaleCourse = { x: layout.whaleHome.x, z: layout.whaleHome.z, heading, leg: heading, speed: CRUISE };
  const stream = createLandStream(land, { segments: 48, sunDirection: new THREE.Vector3(0.3, 0.6, 0.2), hazeColor: new THREE.Color(0xc8d8e0) });
  const parent = new THREE.Group();
  const ships = createShipStream({ seed: 42, maskAt: land.maskAt, startSpecs: layout.ships, parent, cap: 8, shoreReady: land.nav.ready });
  const origin = createWorldOrigin();
  let recentres = 0;
  origin.onRecenter(() => recentres++);
  stream.prime(course.x, course.z);
  land.nav.prefetch(course.x, course.z, OPENING_NAV_RADIUS, Infinity);

  const peak = { tiles: 0, meshes: 0, triangles: 0, ready: 0, navTiles: 0, navBlocks: 0, shipCells: 0, ships: 0, plan: 0 };
  let px = course.x;
  let pz = course.z;
  let vx: number;
  let vz: number;
  let early = 0;
  for (let i = 0; i < 3600 / DT; i++) {
    pilot.step(course, DT, i * DT, land);
    if (i % SERVICE !== 0) continue;
    const dt = SERVICE * DT;
    vx = (course.x - px) / dt;
    vz = (course.z - pz) / dt;
    px = course.x;
    pz = course.z;
    origin.maybeRecenter(course.x, course.z);
    // As world.ts does: nav tiles and ships around the point 20 s ahead (at most 700 m), land tiles around the whale.
    const k = Math.min(20, 700 / Math.max(1e-6, Math.hypot(vx, vz)));
    const ax = course.x + vx * k;
    const az = course.z + vz * k;
    land.nav.prefetch(ax, az, PLAN_REACH + 700, 4);
    ships.update(dt, i * DT, course.x, course.z, land, ax, az);
    stream.update(course.x, course.z, dt, vx, vz);
    const s = stream.stats();
    const n = land.nav.stats();
    const f = ships.stats();
    peak.tiles = Math.max(peak.tiles, s.tiles);
    peak.meshes = Math.max(peak.meshes, stream.group.children.length);
    peak.triangles = Math.max(peak.triangles, s.triangles);
    peak.ready = Math.max(peak.ready, s.ready);
    peak.navTiles = Math.max(peak.navTiles, n.tiles);
    peak.navBlocks = Math.max(peak.navBlocks, n.blocks);
    peak.shipCells = Math.max(peak.shipCells, f.cells);
    peak.ships = Math.max(peak.ships, f.ships);
    peak.plan = Math.max(peak.plan, course.planCache?.size ?? 0);
    if (i === Math.round(600 / DT / SERVICE) * SERVICE) {
      collect();
      early = process.memoryUsage().heapUsed;
    }
  }
  collect();
  const growth = (process.memoryUsage().heapUsed - early) / 1e6;
  // Tiles of open sea are empty entries; the ones that carry a rock or islet are drawn, and dissolve in and out.
  assert.ok(peak.tiles < 480 && peak.ready <= 96, `land tiles ${String(peak.tiles)}, ready ${String(peak.ready)}`);
  assert.ok(peak.meshes <= 200 && peak.triangles <= 60000, `land meshes ${String(peak.meshes)}, triangles ${String(peak.triangles)}`);
  assert.ok(peak.navTiles <= 256 && peak.navBlocks <= 320, `nav tiles ${String(peak.navTiles)}, blocks ${String(peak.navBlocks)}`);
  assert.ok(peak.shipCells <= 60 && peak.ships <= 120, `ship cells ${String(peak.shipCells)}, ships ${String(peak.ships)}`);
  assert.ok(peak.plan <= 40000, `plan cache ${String(peak.plan)}`);
  assert.ok(growth < 50, `heap grew ${growth.toFixed(1)} MB between minute 10 and minute 60`);
  assert.ok(recentres <= 3600 / 120 + 1, `${String(recentres)} recentres in an hour`);
  stream.dispose();
  ships.dispose();
}, 600000);

test('the first whale steps build no navigation tile once the opening ones are built', () => {
  for (const seed of [42, 7, 1234, 99, 2024, 31337]) {
    const layout = layoutWorld(seed);
    const land = layout.land;
    const pilot = createWhalePilot(seed, layout.whaleHome, layout.journey);
    const course: WhaleCourse = { x: layout.whaleHome.x, z: layout.whaleHome.z, heading: layout.journey, leg: layout.journey, speed: CRUISE };
    land.nav.prefetch(course.x, course.z, OPENING_NAV_RADIUS, Infinity);
    const built = land.nav.stats().tiles;
    for (let i = 0; i < 3 * 30; i++) pilot.step(course, DT, i * DT, land);
    assert.equal(land.nav.stats().tiles, built, `seed ${String(seed)} built tiles in its first steps`);
  }
}, 60000);
