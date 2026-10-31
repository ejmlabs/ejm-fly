import type * as THREE from 'three';
import { hash, random } from './rng.js';
import { SHIP_CELL, cellDistance, chunksAround, createChunkStreamer, parseChunkKey } from './chunks.js';
import { createShip, createShips, type ShipHandle } from './ships.js';
import type { ShipSpec } from './terrain.js';
import type { Shore } from './shore.js';
import { damp, smoothstep } from './math.js';
import { item } from './item.js';

/** Cells are loaded within this distance of the whale, so a new ship always appears beyond the fade. */
const LOAD = 1800;
/** …and dropped beyond this one (wider, so a boundary never thrashes). */
const KEEP = 2400;
/** Ships sink below the haze between these distances from the whale. */
const SHOW = 1250;
const HIDE = 1650;
/** Sails sway only on ships this near the whale: the cloth moves under a pixel from further, and rewriting every sail vertex is the ship stream's main cost. */
const BILLOW = 400;
/** Metres a hidden ship sits below the surface. */
const SINK = 8;
const START_KEY = 'start';

// Numeric salts: string salts all hash alike (see rng.ts).
const SALT_COUNT = 0x5348;
const SALT_PLACE = 0x5349;
const SALT_SEED = 0x5350;
const SALT_ID = 0x5351;

/** The start ships come from the layout; random ships keep out of the opening view. */
const START_CLEAR = 1700;

/** Open water by the coast mask alone (cheap, valid anywhere): the point and a ring around it are at sea. */
function openWater(maskAt: (x: number, z: number) => number, x: number, z: number, radius: number): boolean {
  const m = maskAt(x, z);
  // Coast masks change ~0.0025 per metre.
  if (!(m < -radius * 0.0025)) return false;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    if (maskAt(x + Math.cos(a) * radius, z + Math.sin(a) * radius) >= 0) return false;
  }
  return true;
}

/** 0–2 ships for a ship cell: a pure function of (seed, cx, cz); `density` scales how many (1 is the open-sea norm). */
export function shipSpecsForCell(seed: number, cx: number, cz: number, maskAt: (x: number, z: number) => number, density = 1): ShipSpec[] {
  const roll = hash(seed, SALT_COUNT, cx, cz) / 0x100000000;
  const count = roll < 1 - 0.58 * density ? 0 : roll < 1 - 0.14 * density ? 1 : 2;
  const rng = random(hash(seed, SALT_PLACE, cx, cz));
  const specs: ShipSpec[] = [];
  for (let k = 0; k < count; k++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const x = (cx + 0.12 + rng() * 0.76) * SHIP_CELL;
      const z = (cz + 0.12 + rng() * 0.76) * SHIP_CELL;
      const kind: ShipSpec['kind'] = rng() > 0.55 ? 'tall' : 'sloop';
      const heading = rng() * Math.PI * 2;
      const scale = kind === 'tall' ? 1.3 * (1.05 + rng() * 0.3) : 0.85 + rng() * 0.3;
      if (Math.hypot(x, z) < START_CLEAR) continue;
      if (specs.some((s) => Math.hypot(s.x - x, s.z - z) < 160)) continue;
      if (!openWater(maskAt, x, z, 140)) continue;
      specs.push({ id: hash(seed, SALT_ID, cx, cz, k), x, z, heading, scale, kind, seed: hash(seed, SALT_SEED, cx, cz, k) });
      break;
    }
  }
  return specs;
}

interface Ship { handle: ShipHandle; vis: number }

export interface ShipStream {
  /** Ships currently afloat and at least partly visible (same array every call). */
  active: () => readonly ShipHandle[];
  /** Every loaded ship, visible or not. */
  all: () => readonly ShipHandle[];
  /** Cells stream around (aheadX, aheadZ), a point the whale is heading for; ships show by distance from the whale. */
  update: (dt: number, time: number, whaleX: number, whaleZ: number, shore: Shore, aheadX?: number, aheadZ?: number) => void;
  setVisible: (visible: boolean) => void;
  stats: () => { cells: number; ships: number; visible: number };
  dispose: () => void;
}

export function createShipStream(options: {
  seed: number;
  maskAt: (x: number, z: number) => number;
  /** Ships per cell relative to the norm at a world position (a region's ship density). */
  density?: (x: number, z: number) => number;
  startSpecs: ShipSpec[];
  parent: THREE.Object3D;
  cap: number;
  shoreReady: (x: number, z: number) => boolean;
}): ShipStream {
  const { seed, maskAt, parent } = options;
  const ships: Ship[] = [];
  const active: ShipHandle[] = [];
  const handles: ShipHandle[] = [];
  let shown = true;
  let primed = false;

  const streamer = createChunkStreamer<Ship[]>({
    wanted(wx, wz) {
      const keys = chunksAround(wx, wz, LOAD, SHIP_CELL);
      if (Math.hypot(wx, wz) < LOAD) keys.unshift(START_KEY);
      return keys;
    },
    keep(key, wx, wz) {
      if (key === START_KEY) return Math.hypot(wx, wz) < KEEP;
      const { cx, cz } = parseChunkKey(key);
      return cellDistance(wx, wz, cx, cz, SHIP_CELL) < KEEP;
    },
    build(key) {
      const made =
        key === START_KEY
          ? createShips(options.startSpecs, { anchor: { x: 0, z: 0 }, leash: 280, shoreReady: options.shoreReady })
          : (() => {
              const { cx, cz } = parseChunkKey(key);
              return shipSpecsForCell(seed, cx, cz, maskAt, options.density?.((cx + 0.5) * SHIP_CELL, (cz + 0.5) * SHIP_CELL)).map((spec) =>
                createShip(spec, { anchor: { x: spec.x, z: spec.z }, leash: 90, shoreReady: options.shoreReady }),
              );
            })();
      // A ship built after the first frame starts sunk and rises as the whale nears.
      const out = made.map((handle) => ({ handle, vis: primed ? 0 : 1 }));
      for (const ship of out) {
        ship.handle.group.position.set(ship.handle.spec.x, -SINK, ship.handle.spec.z);
        ship.handle.group.visible = false;
        parent.add(ship.handle.group);
        ships.push(ship);
      }
      return out;
    },
    dispose(items) {
      for (const ship of items) {
        parent.remove(ship.handle.group);
        ship.handle.dispose();
        ships.splice(ships.indexOf(ship), 1);
      }
    },
    maxBuildsPerFrame: 1,
  });

  const order: { ship: Ship; d: number }[] = [];
  const streamedAt = { x: Infinity, z: Infinity };
  let filling = true;

  return {
    active: () => active,
    all: () => handles,
    update(dt, time, wx, wz, shore, ax = wx, az = wz) {
      // Cells only change every few hundred metres: look again after 50, or while still filling in.
      if (filling || Math.hypot(ax - streamedAt.x, az - streamedAt.z) > 50) {
        const before = streamer.loaded.size;
        streamer.update(ax, az);
        filling = streamer.loaded.size > before;
        streamedAt.x = ax;
        streamedAt.z = az;
      }
      order.length = 0;
      for (const ship of ships) {
        const p = ship.handle.group.position;
        order.push({ ship, d: Math.hypot(p.x - wx, p.z - wz) });
      }
      order.sort((a, b) => a.d - b.d);
      active.length = 0;
      handles.length = 0;
      for (let i = 0; i < order.length; i++) {
        const { ship, d } = item(order, i);
        handles.push(ship.handle);
        const target = i < options.cap ? 1 - smoothstep(SHOW, HIDE, d) : 0;
        ship.vis = primed ? damp(ship.vis, target, 0.9, dt) : target;
        if (Math.abs(ship.vis - target) < 0.002) ship.vis = target;
        const group = ship.handle.group;
        group.visible = shown && ship.vis > 0.002;
        if (!group.visible) continue;
        ship.handle.update(dt, time, shore, d < BILLOW);
        group.position.y -= (1 - ship.vis) * SINK;
        active.push(ship.handle);
      }
      primed = true;
    },
    setVisible(visible) {
      shown = visible;
      for (const ship of ships) ship.handle.group.visible = visible && ship.vis > 0.002;
    },
    stats() {
      return { cells: streamer.loaded.size, ships: ships.length, visible: active.length };
    },
    dispose() {
      streamer.dispose();
    },
  };
}

