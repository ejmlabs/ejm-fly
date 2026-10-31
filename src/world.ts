import * as THREE from 'three';
import type { WorldLayout } from './terrain.js';
import { farShelf, farShelfSteps, navShelfSteps, nearShelf, type Land, type ShelfMap } from './land.js';
import { createOcean, type OceanHandle } from './ocean.js';
import { createLandStream, type Dissolve, type LandStream } from './landmesh.js';
import { createShipStream } from './world-ships.js';
import { createWorldOrigin, type WorldOrigin } from './world-origin.js';
import type { Shore } from './shore.js';
import type { ShipHandle } from './ships.js';
import type { WorkerRequest } from './world-worker.js';
import { damp } from './math.js';
import { blendLook } from './regions.js';
import { OPENING_NAV_RADIUS, PLAN_REACH } from './whale-course.js';
import { createWalkers } from './walkers.js';
import { createSliceCost } from './slice-cost.js';
import type { DetailBudget } from './quality.js';

export interface WorldOptions {
  sunDirection: THREE.Vector3;
  hazeColor: THREE.Color;
  hazeDensity: number;
  hazeGradient: { angles: number[]; colors: THREE.Color[] };
  /** Low sun lights the shallows less. */
  shallowLight: number;
  waterSize: number;
  landSegments: number;
  /** Life on the land and its surface detail, by quality tier. */
  detail: Pick<DetailBudget, 'objects' | 'walkers' | 'microNormal'>;
  /** Fewer ships on small screens. */
  mobile: boolean;
  /** Build land tiles and far shelf maps in a worker (browser). */
  worker?: boolean;
  /** How fading land tiles dissolve (see `LandStreamOptions`); a dither unless the frame is multisampled. */
  dissolve?: Dissolve | undefined;
}

export interface World {
  /** Parent for everything placed in world coordinates (whale, ships, land, birds); sits at −origin. */
  root: THREE.Group;
  origin: WorldOrigin;
  shore: Shore;
  land: Land;
  ocean: OceanHandle;
  landStream: LandStream;
  /** People and animals drawn now may number at most this (follows the quality tier). */
  setWalkerCap: (cap: number) => void;
  /**
   * Materials first drawn only after the opening frame (land dissolving in, people and animals), to compile ahead of
   * that frame.
   */
  laterMaterials: readonly THREE.Material[];
  ships: {
    /** Ships afloat and visible (stable array). */
    active: () => readonly ShipHandle[];
    setVisible: (visible: boolean) => void;
  };
  /** Streams land, ships and shelves around the whale and recentres the origin if needed. */
  update: (whaleWorldX: number, whaleWorldZ: number, camera: THREE.Camera, dt: number, time: number) => void;
  stats: () => Record<string, number | number[]>;
  dispose: () => void;
}

/**
 * All streaming work on the main thread (tiles, ships, navigation, shelf bakes) stays near this per frame. A loop of
 * slices stops once the time left would not hold another slice of its job (`slice-cost.ts`).
 */
const BUDGET_MS = 2.5;
/** Navigation tiles and ship cells are centred this many seconds ahead along the whale's motion (capped in metres). */
const LEAD = 20;
const LEAD_MAX = 700;
/** Navigation tiles are kept built this far around the point ahead of the whale (covers the route plan, which reaches PLAN_REACH from a whale up to LEAD_MAX behind that point, and the next shelf bake). */
const NAV_RADIUS = PLAN_REACH + LEAD_MAX;
/** Faster than this between two frames is a jump (debug travel, reload), not swimming. */
const JUMP_SPEED = 60;
/** A camera further than this from the whale is not following it (e.g. during a fast-forward): stream around the whale. */
const CAMERA_LEASH = 200;
/** Worst-frame stats cover roughly this many seconds. */
const WORST_WINDOW = 10;
const FAR_SIZE = 384;
const FAR_EXTENT = 6400;
/** Shelf maps are baked around the point ahead of the whale again once it is this far from the centre of the ones in use (the near map reaches 1.6 km, the far one 6.4 km, from their centres). */
const NEAR_STEP = 700;
const FAR_STEP = 1280;
/** Shelf map centres lie on this lattice (the navigation field's own tile grid is finer). */
const SHELF_SNAP = 256;

export function createWorld(seed: number, layout: WorldLayout, scene: THREE.Scene, options: WorldOptions): World {
  const land = layout.land;
  const origin = createWorldOrigin();
  const root = new THREE.Group();
  root.name = 'world';
  scene.add(root);

  // Opening maps around the start, exactly as before the world went endless.
  const ocean = createOcean(seed, options.sunDirection, {
    textureSize: options.waterSize,
    waterColor: 0x1c5470,
    shelves: { near: nearShelf(land), far: farShelf(land), light: options.shallowLight },
  });
  scene.add(ocean.mesh);

  const landStream = createLandStream(land, {
    segments: options.landSegments,
    sunDirection: options.sunDirection,
    hazeColor: options.hazeColor,
    hazeDensity: options.hazeDensity,
    hazeGradient: options.hazeGradient,
    worker: options.worker,
    objects: options.detail.objects,
    microNormal: options.detail.microNormal,
    dissolve: options.dissolve,
  });
  root.add(landStream.group);
  const walkers = createWalkers(landStream, options.detail.walkers);
  root.add(walkers.group);
  // Their own clock: still when the frame step is (reduced motion), and not hurried by the swell.
  let walkerClock = 0;
  landStream.prime(layout.whaleHome.x, layout.whaleHome.z);

  // The whale's first minutes need no stall: build the water around the start now.
  land.nav.prefetch(layout.whaleHome.x, layout.whaleHome.z, OPENING_NAV_RADIUS, Infinity);

  const ships = createShipStream({
    seed,
    maskAt: land.maskAt,
    density: (x, z) => blendLook(land.regions.weightsAt(x, z), (look) => look.ships),
    startSpecs: layout.ships,
    parent: root,
    cap: options.mobile ? 5 : 8,
    shoreReady: land.nav.ready,
  });

  // Shelf bakes for the ocean as the whale travels: exact near map from the nav tiles, coarse far map.
  let nearJob: Generator<void, ShelfMap> | null = null;
  let nearAt = { x: 0, z: 0 };
  let farJob: Generator<void, ShelfMap> | null = null;
  let farAt = { x: 0, z: 0 };
  let farId = 0;
  let farWaiting = false;
  const bakeCost = createSliceCost();
  let frameStart = 0;
  /** What is left of this frame's budget. */
  const left = () => BUDGET_MS - (performance.now() - frameStart);
  let worker: Worker | null = null;
  if (options.worker && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./world-worker.ts', import.meta.url), { type: 'module' });
      const init: WorkerRequest = { type: 'init', seed: land.seed, viewYaw: land.viewYaw, offset: land.offset };
      worker.postMessage(init);
      worker.onmessage = (event: MessageEvent<{ type: string; id: number; shelf: ShelfMap }>) => {
        if (event.data.type === 'far' && event.data.id === farId) {
          ocean.setShelves({ far: event.data.shelf });
          farWaiting = false;
        }
      };
      worker.onerror = () => {
        worker?.terminate();
        worker = null;
        if (farWaiting) farJob = farSteps(farAt.x, farAt.z);
        farWaiting = false;
      };
    } catch {
      worker = null;
    }
  }

  const farSteps = (cx: number, cz: number) => farShelfSteps(land, FAR_SIZE, FAR_EXTENT, cx, cz);

  function* nearSteps(cx: number, cz: number): Generator<void, ShelfMap> {
    // No time of its own: a call builds one slice (so each step is one), and the frame's loop spends the budget.
    while (!land.nav.prefetch(cx, cz, 1600 * Math.SQRT2, 0)) yield;
    return yield* navShelfSteps(land, cx, cz);
  }

  /** A bake's slices until the frame's budget cannot hold another; its map once done. */
  function advance(job: Generator<void, ShelfMap>): ShelfMap | undefined {
    while (bakeCost.fits(left())) {
      const t = performance.now();
      const next = job.next();
      bakeCost.note(performance.now() - t);
      if (next.done) return next.value;
    }
    return undefined;
  }

  const snapShelf = (v: number) => Math.round(v / SHELF_SNAP) * SHELF_SNAP;

  function bakeShelves(x: number, z: number): void {
    const cx = snapShelf(x);
    const cz = snapShelf(z);
    if (!nearJob && Math.hypot((whale[0] ?? 0) - nearAt.x, (whale[1] ?? 0) - nearAt.z) > NEAR_STEP) {
      nearAt = { x: cx, z: cz };
      nearJob = nearSteps(cx, cz);
    }
    if (!farJob && !farWaiting && Math.hypot((whale[0] ?? 0) - farAt.x, (whale[1] ?? 0) - farAt.z) > FAR_STEP) {
      farAt = { x: cx, z: cz };
      if (worker) {
        farId++;
        farWaiting = true;
        const request: WorkerRequest = { type: 'far', id: farId, size: FAR_SIZE, extent: FAR_EXTENT, cx, cz };
        worker.postMessage(request);
      } else {
        farJob = farSteps(cx, cz);
      }
    }
  }

  origin.onRecenter(() => {
    root.position.set(-origin.x, 0, -origin.z);
    root.updateMatrixWorld();
    ocean.setOrigin(origin.x, origin.z);
    landStream.setOrigin(origin.x, origin.z);
    recentres++;
  });

  const cameraWorld = new THREE.Vector3();
  let whale = [layout.whaleHome.x, layout.whaleHome.z];
  // Whale velocity, smoothed from successive positions.
  let vx = 0;
  let vz = 0;
  let windowAge = 0;
  let worst = [0, 0];
  let lastMs = 0;
  let holeFrames = 0;
  let recentres = 0;
  let navMisses = 0;

  return {
    root,
    origin,
    shore: land,
    land,
    ocean,
    landStream,
    setWalkerCap: walkers.setCap,
    laterMaterials: [...landStream.materials, ...walkers.materials],
    ships: { active: ships.active, setVisible: ships.setVisible },
    update(wx, wz, camera, dt, time) {
      const start = performance.now();
      frameStart = start;
      if (dt > 0) {
        const rx = (wx - (whale[0] ?? 0)) / dt;
        const rz = (wz - (whale[1] ?? 0)) / dt;
        if (Math.hypot(rx, rz) > JUMP_SPEED) {
          vx = 0;
          vz = 0;
        } else {
          vx = damp(vx, rx, 1.5, dt);
          vz = damp(vz, rz, 1.5, dt);
        }
      }
      whale = [wx, wz];
      // The camera is still in the old render space until the rig moves it: read it first.
      cameraWorld.copy(camera.position);
      cameraWorld.x += origin.x;
      cameraWorld.z += origin.z;
      if (Math.hypot(cameraWorld.x - wx, cameraWorld.z - wz) > CAMERA_LEASH) cameraWorld.set(wx, 0, wz);
      origin.maybeRecenter(wx, wz);
      landStream.update(cameraWorld.x, cameraWorld.z, dt, vx, vz);
      walkerClock += dt;
      walkers.update(cameraWorld.x, cameraWorld.z, walkerClock);
      const k = Math.min(LEAD, LEAD_MAX / Math.max(1e-6, Math.hypot(vx, vz)));
      const ax = wx + vx * k;
      const az = wz + vz * k;
      ships.update(dt, time, wx, wz, land, ax, az);
      bakeShelves(ax, az);

      const near = nearJob && advance(nearJob);
      if (near) {
        ocean.setShelves({ near });
        nearJob = null;
      }
      const far = farJob && advance(farJob);
      if (far) {
        ocean.setShelves({ far });
        farJob = null;
      }
      if (left() > 0) land.nav.prefetch(ax, az, NAV_RADIUS, left());

      lastMs = performance.now() - start;
      windowAge += dt;
      if (windowAge > WORST_WINDOW) {
        worst = [worst[1] ?? 0, 0];
        windowAge = 0;
      }
      worst[1] = Math.max(worst[1] ?? 0, lastMs);
      if (landStream.stats().holes > 0) holeFrames++;
      if (!land.nav.ready(wx + vx * 3, wz + vz * 3)) navMisses++;
    },
    stats() {
      const tiles = landStream.stats();
      const nav = land.nav.stats();
      const fleet = ships.stats();
      const life = walkers.stats();
      return {
        origin: [origin.x, origin.z],
        whaleWorld: whale,
        chunks: tiles.tiles,
        chunksPending: tiles.pending,
        chunksFading: tiles.fading,
        chunksReady: tiles.ready,
        /** Frames so far with a hole in the land inside the haze. */
        coverageMisses: holeFrames,
        streamMs: lastMs,
        streamWorstMs: Math.max(worst[0] ?? 0, worst[1] ?? 0),
        whaleSpeed: Math.hypot(vx, vz),
        landTriangles: tiles.triangles,
        /** Trees, rocks and houses in the wanted tiles drawn now, and their triangles. */
        landObjects: tiles.objects,
        objectTriangles: tiles.objectTriangles,
        walkers: life.walkers,
        walkerDraws: life.draws,
        walkerTriangles: life.triangles,
        walkerClock,
        navTiles: nav.tiles,
        navBlocks: nav.blocks,
        recentres,
        /** Frames so far in which the navigation tile 3 s ahead of the whale was not built. */
        navMisses,
        shipCells: fleet.cells,
        shipsLoaded: fleet.ships,
        shipsVisible: fleet.visible,
      };
    },
    dispose() {
      worker?.terminate();
      ships.dispose();
      walkers.dispose();
      landStream.dispose();
      ocean.dispose();
      scene.remove(root);
      scene.remove(ocean.mesh);
    },
  };
}
