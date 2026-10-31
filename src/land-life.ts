import { fbm2, makeNoise2D } from './noise.js';
import { hash } from './rng.js';
import { smoothstep } from './math.js';
import type { Land } from './land.js';
import type { RegionWeights } from './regions.js';
import { item } from './item.js';

/**
 * Where life stands on the land, as a pure function of the seed and the land:
 * forest cover, trees and rocks on a nested lattice, coastal towns per town
 * cell, and grazing herds per herd cell. Worker-safe (no three.js).
 */

export type LifeLand = Pick<Land, 'seed' | 'maskAt' | 'surfaceAt' | 'regions'>;

/** Tiles at levels below this carry trees, rocks and houses; walkers come from levels below WALKER_LEVELS. */
export const OBJECT_LEVELS = 5;
export const WALKER_LEVELS = 3;
/** Lattice of tree, shrub and boulder candidates (divides the finest tile). */
export const TREE_CELL = 8;
export const TOWN_CELL = 1600;
export const HERD_CELL = 384;
/** Towns are always tried this close to the start, so the opening coast often has one. */
const TOWN_HOME = 4500;

export const TREE = { conifer: 0, broadleaf: 1, palm: 2, shrub: 3, boulder: 4 } as const;
export const WALKER = { person: 0, sheep: 1, cow: 2, deer: 3, reindeer: 4, goat: 5 } as const;

export interface House { x: number; z: number; yaw: number; width: number; depth: number; height: number; wall: number; roof: number; tower: boolean }
/** A person or an animal: where it stands, the line it paces along (`range` metres each way), and its look. */
export interface Walker { kind: number; x: number; z: number; yaw: number; range: number; phase: number; tint: number }
export interface Town { x: number; z: number; region: number; houses: House[]; people: Walker[] }

export interface Biome {
  /** Highest trees, in metres. */
  treeline: number;
  /** Base forest cover, 0 to 1. */
  cover: number;
  tropical: number;
  polar: number;
}

export interface LandLife {
  seed: number;
  biome: (weights: RegionWeights) => Biome;
  /** Forest cover in [0, 1] at a point of the drawn surface (height in metres, `slopeY` the normal's Y, `cliff` the land's cliff face weight). */
  forestAt: (x: number, z: number, height: number, slopeY: number, cliff: number, biome: Biome) => number;
  /** The town of a town cell, or null. */
  town: (ci: number, cj: number) => Town | null;
  /** The herd of a herd cell (empty when none). */
  herd: (hi: number, hj: number) => Walker[];
}

/** Unit value per lattice point, cheaper than `hash` for the tile loops. */
export function latticeUnit(seed: number, salt: number, i: number, j: number): number {
  let h = Math.imul(seed ^ salt, 0x9e3779b1) ^ Math.imul(i, 0x85ebca6b) ^ Math.imul(j, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

const unit = (...values: number[]) => hash(...values) / 0x100000000;
/** Numeric salts: string salts all hash alike (see rng.ts). */
const SALT_TOWN = 0x746f776e;
const SALT_HERD = 0x68657264;
const SALT_FOREST = 0x66727374;

export function createLandLife(land: LifeLand): LandLife {
  const seed = land.seed;
  const forestNoise = makeNoise2D(hash(seed, SALT_FOREST), 1);
  const surface = { cliff: 0 };
  const towns = new Map<string, Town | null>();
  const herds = new Map<string, Walker[]>();
  const weights: RegionWeights = [0, 0, 0, 0];

  function biome(w: RegionWeights): Biome {
    return {
      treeline: 520 * w[0] + 760 * w[1] + 230 * w[2] + 480 * w[3],
      cover: 0.55 * w[0] + 0.7 * w[1] + 0.3 * w[2] + 0.45 * w[3],
      tropical: w[1],
      polar: w[2],
    };
  }

  function forestAt(x: number, z: number, height: number, slopeY: number, cliff: number, b: Biome): number {
    const patches = fbm2(forestNoise, x / 650, z / 650, 3) + (b.cover - 0.5) * 0.8;
    const altitude = smoothstep(3.5, 10, height) * (1 - smoothstep(b.treeline * 0.65, b.treeline, height));
    return smoothstep(-0.12, 0.3, patches) * altitude * smoothstep(0.74, 0.9, slopeY) * (1 - smoothstep(0.05, 0.25, cliff));
  }

  /** Height, cliff weight and the largest rise over `span` metres around (x, z). */
  function ground(x: number, z: number, span: number): { h: number; cliff: number; rise: number } {
    const h = land.surfaceAt(x, z, 0, surface);
    const cliff = surface.cliff;
    let rise = 0;
    for (const [dx, dz] of [[span, 0], [-span, 0], [0, span], [0, -span]] as const) rise = Math.max(rise, Math.abs(land.surfaceAt(x + dx, z + dz, 0, surface) - h));
    return { h, cliff, rise };
  }

  function town(ci: number, cj: number): Town | null {
    const key = `${String(ci)},${String(cj)}`;
    const known = towns.get(key);
    if (known !== undefined) return known;
    const built = buildTown(ci, cj);
    if (towns.size > 512) towns.clear();
    towns.set(key, built);
    return built;
  }

  function buildTown(ci: number, cj: number): Town | null {
    const cx = (ci + 0.5) * TOWN_CELL;
    const cz = (cj + 0.5) * TOWN_CELL;
    land.regions.weightsAt(cx, cz, weights);
    const chance = Math.hypot(cx, cz) < TOWN_HOME ? 1 : 0.6 - 0.3 * weights[2] - 0.15 * weights[3];
    if (unit(seed, SALT_TOWN, ci, cj) >= chance) return null;
    for (let k = 0; k < 14; k++) {
      const x = (ci + 0.1 + 0.8 * unit(seed, SALT_TOWN, ci, cj, k, 1)) * TOWN_CELL;
      const z = (cj + 0.1 + 0.8 * unit(seed, SALT_TOWN, ci, cj, k, 2)) * TOWN_CELL;
      const m = land.maskAt(x, z);
      if (m < 0.012 || m > 0.16) continue;
      const site = ground(x, z, 25);
      if (site.h < 2.5 || site.h > 34 || site.cliff > 0.1 || site.rise > 6) continue;
      // The sea must be close: the street runs along the coast, the houses look out over the water.
      let sx = 0;
      let sz = 0;
      for (let b = 0; b < 8; b++) {
        const a = (b / 8) * Math.PI * 2;
        if (land.maskAt(x + Math.cos(a) * 190, z + Math.sin(a) * 190) < -0.01) {
          sx += Math.cos(a);
          sz += Math.sin(a);
        }
      }
      if (Math.hypot(sx, sz) < 0.5) continue;
      return layTown(ci, cj, x, z, Math.atan2(sz, sx));
    }
    return null;
  }

  function layTown(ci: number, cj: number, x: number, z: number, seaward: number): Town | null {
    const r = (n: number) => unit(seed, SALT_TOWN, ci, cj, 100 + n);
    const region = weights.indexOf(Math.max(...weights));
    const wanted = region === 2 ? 6 + Math.floor(r(0) * 4) : 6 + Math.floor(r(0) * 13);
    // The street runs along the coast.
    const ax = -Math.sin(seaward);
    const az = Math.cos(seaward);
    const bx = Math.cos(seaward);
    const bz = Math.sin(seaward);
    const houses: House[] = [];
    const walls = item(WALLS, region);
    const roofs = item(ROOFS, region);
    for (let n = 0; houses.length < wanted && n < wanted * 3; n++) {
      const slot = Math.floor(n / 2);
      const side = n % 2 ? 1 : -1;
      const back = slot >= wanted / 2 ? 1 : 0;
      const along = (slot - back * Math.ceil(wanted / 2) - wanted / 4) * 12 + (r(10 + n) - 0.5) * 4;
      const across = side * (8 + back * 15 + r(40 + n) * 3);
      const hx = x + ax * along + bx * across;
      const hz = z + az * along + bz * across;
      if (land.maskAt(hx, hz) < 0.01) continue;
      if (houses.some((h) => Math.hypot(h.x - hx, h.z - hz) < 9)) continue;
      const site = ground(hx, hz, 4);
      if (site.h < 1.8 || site.cliff > 0.15 || site.rise > 3) continue;
      const tower = houses.length === 2 && wanted >= 9;
      houses.push({
        x: hx,
        z: hz,
        // Gable ends face the street.
        yaw: seaward + (side > 0 ? Math.PI : 0) + (r(70 + n) - 0.5) * 0.16,
        width: tower ? 4.5 : 5 + r(80 + n) * 2.5,
        depth: tower ? 4.5 : 6 + r(90 + n) * 2.5,
        height: tower ? 11 + r(95) * 5 : 3.4 + r(100 + n) * 1.8,
        wall: walls[Math.floor(r(110 + n) * walls.length)] ?? 0,
        roof: roofs[Math.floor(r(120 + n) * roofs.length)] ?? 0,
        tower,
      });
    }
    if (houses.length < 6) return null;
    const people: Walker[] = [];
    const crowd = Math.min(14, Math.round(houses.length * 0.9));
    for (let n = 0; n < crowd; n++) {
      const home = item(houses, Math.floor(r(200 + n) * houses.length));
      // Out on the street in front of a house, pacing along it; a few stand chatting.
      const t = (home.x - x) * ax + (home.z - z) * az + (r(220 + n) - 0.5) * 6;
      const px = x + ax * t + bx * (r(230 + n) - 0.5) * 6;
      const pz = z + az * t + bz * (r(230 + n) - 0.5) * 6;
      if (land.maskAt(px, pz) < 0.006) continue;
      const still = r(240 + n) < 0.25;
      people.push({ kind: WALKER.person, x: px, z: pz, yaw: Math.atan2(ax, az) + (r(250 + n) < 0.5 ? 0 : Math.PI) + (r(255 + n) - 0.5) * 0.5, range: still ? 0 : 2 + r(260 + n) * 7, phase: r(270 + n) * 6.283, tint: Math.floor(r(280 + n) * 6) });
    }
    return { x, z, region, houses, people };
  }

  function herd(hi: number, hj: number): Walker[] {
    const key = `${String(hi)},${String(hj)}`;
    const known = herds.get(key);
    if (known) return known;
    const built = buildHerd(hi, hj);
    if (herds.size > 2048) herds.clear();
    herds.set(key, built);
    return built;
  }

  function buildHerd(hi: number, hj: number): Walker[] {
    const r = (n: number) => unit(seed, SALT_HERD, hi, hj, n);
    if (r(0) > 0.3) return [];
    const x = (hi + 0.2 + 0.6 * r(1)) * HERD_CELL;
    const z = (hj + 0.2 + 0.6 * r(2)) * HERD_CELL;
    if (land.maskAt(x, z) < 0.03) return [];
    const site = ground(x, z, 20);
    if (site.h < 4 || site.cliff > 0.05 || site.rise > 5) return [];
    land.regions.weightsAt(x, z, weights);
    const b = biome(weights);
    const region = weights.indexOf(Math.max(...weights));
    if (site.h > b.treeline * 1.1) return [];
    // Meadows only: herds keep out of the forest.
    if (forestAt(x, z, site.h, 1 - site.rise / 40, site.cliff, b) > 0.3) return [];
    const ci = Math.floor(x / TOWN_CELL);
    const cj = Math.floor(z / TOWN_CELL);
    let farm = false;
    for (let dj = -1; dj <= 1 && !farm; dj++) {
      for (let di = -1; di <= 1 && !farm; di++) {
        const t = town(ci + di, cj + dj);
        if (t && Math.hypot(t.x - x, t.z - z) < 900) farm = true;
      }
    }
    const kind = farm ? (r(3) < 0.65 ? WALKER.sheep : WALKER.cow) : item([WALKER.deer, WALKER.goat, WALKER.reindeer, WALKER.goat], region);
    const out: Walker[] = [];
    const count = 3 + Math.floor(r(4) * 6);
    const heading = r(5) * Math.PI * 2;
    for (let n = 0; n < count; n++) {
      const a = r(10 + n) * Math.PI * 2;
      const d = 3 + r(20 + n) * 13;
      const px = x + Math.cos(a) * d;
      const pz = z + Math.sin(a) * d;
      if (land.maskAt(px, pz) < 0.02) continue;
      // A herd faces roughly one way and drifts while it grazes.
      out.push({ kind, x: px, z: pz, yaw: heading + (r(30 + n) - 0.5) * 1.6, range: r(40 + n) * 1.5, phase: r(50 + n) * 6.283, tint: Math.floor(r(60 + n) * 3) });
    }
    return out;
  }

  return { seed, biome, forestAt, town, herd };
}

/** Wall and roof colours (sRGB hex) by region: temperate, tropical, polar, deep blue. */
const WALLS: readonly (readonly number[])[] = [
  [0xe9e3d3, 0xe4d4ae, 0xd8bf95, 0xdcd8cf, 0xcfd5d8],
  [0xf1ece0, 0xe9d9b5, 0xe6c7b6, 0xcfe0dc, 0xf0e2c0],
  [0xa4473a, 0xc49a52, 0xe0dccf, 0x8b5a3c, 0x5f6f78],
  [0xeeeae0, 0xd9cfb6, 0xc7d3d6, 0xe8dcc4],
];
const ROOFS: readonly (readonly number[])[] = [
  [0x8a4a36, 0x5a5f68, 0x9c5a3e, 0x4c5158],
  [0xa65a3a, 0xb46d45, 0x8f6a45],
  [0x3f4348, 0x4f3a32, 0x2f3a40],
  [0x9a5638, 0x58606a, 0x7a4a38],
];
