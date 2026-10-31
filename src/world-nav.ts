import type { Shore } from './shore.js';
import { trimOldest } from './bounded.js';
import { createSliceCost } from './slice-cost.js';

/**
 * Navigation field valid anywhere: the signed coast distance on a fixed world
 * lattice, built in square tiles on demand. Each tile's distance transform runs
 * over a padded window, so values are exact up to `saturation` metres and
 * clamped beyond. A tile is a pure function of its coordinates, so anything
 * steered by it is independent of build order and frame timing; prefetching
 * only decides when the work happens.
 */
export type NavField = Shore & {
  /** Signed metres to the coast: > 0 at sea, < 0 on land, clamped to ±saturation. */
  distanceAt: (x: number, z: number) => number;
  /** Whether the tile holding (x, z) is built (reading it would not stall). */
  ready: (x: number, z: number) => boolean;
  /**
   * Builds missing tiles within `radius` of (x, z), nearest first, in slices, and stops once the time left in `budgetMs`
   * would not hold another; a call builds at least one slice. True once all are built.
   */
  prefetch: (x: number, z: number, radius: number, budgetMs: number) => boolean;
  readonly min: number;
  readonly cell: number;
  readonly saturation: number;
  stats: () => { tiles: number; blocks: number };
};

export interface NavOptions {
  /** World X/Z of lattice index 0. */
  min: number;
  cell: number;
  /** Cells per tile side. */
  tile?: number;
  /** Cells of padding around a tile for its distance transform (at most `tile`). */
  pad?: number;
  maxTiles?: number;
  now?: () => number;
  /** Mask samples already computed elsewhere on the same lattice (must equal fround(maskAt)). */
  known?: (i: number, j: number) => number | undefined;
}

export function createNavField(maskAt: (x: number, z: number) => number, options: NavOptions): NavField {
  const { min, cell } = options;
  const T = options.tile ?? 64;
  const P = Math.min(T, options.pad ?? 32);
  const maxTiles = options.maxTiles ?? 160;
  const maxBlocks = maxTiles + 64;
  /** Lines of the distance transform per slice of a tile build (about a fifth of a millisecond). */
  const TILE_LINES = 32;
  const now = options.now ?? (() => performance.now());
  const cost = createSliceCost();
  const saturation = P * cell;
  const span = T + 1;
  const W = T + 2 * P + 1;

  /** Mask samples of a T×T block of lattice points (rounded to float32 so any builder agrees). */
  const blocks = new Map<string, Float32Array>();
  const tiles = new Map<string, Float32Array>();
  let pending: { key: string; bx: number; bz: number; data: Float32Array; row: number } | null = null;

  function touch<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
    map.delete(key);
    map.set(key, value);
    trimOldest(map, cap);
  }

  function blockRows(job: NonNullable<typeof pending>, until: () => boolean): boolean {
    const x0 = job.bx * T;
    const z0 = job.bz * T;
    while (job.row < T) {
      const j = z0 + job.row;
      const z = min + j * cell;
      for (let i = 0; i < T; i++) {
        job.data[job.row * T + i] = options.known?.(x0 + i, j) ?? Math.fround(maskAt(min + (x0 + i) * cell, z));
      }
      job.row++;
      if (until()) break;
    }
    return job.row >= T;
  }

  function block(bx: number, bz: number): Float32Array {
    const key = `${String(bx)}:${String(bz)}`;
    const hit = blocks.get(key);
    if (hit) {
      touch(blocks, key, hit, maxBlocks);
      return hit;
    }
    const job = pending?.key === key ? pending : { key, bx, bz, data: new Float32Array(T * T), row: 0 };
    blockRows(job, () => false);
    if (pending === job) pending = null;
    touch(blocks, key, job.data, maxBlocks);
    return job.data;
  }

  const toLand = new Float64Array(W * W);
  const toSea = new Float64Array(W * W);
  const f = new Float64Array(W);
  const d = new Float64Array(W);
  const v = new Int32Array(W);
  const zz = new Float64Array(W + 1);

  /** buildTile in slices (a few dozen lines of the distance transform each); the scratch grids belong to the one tile being built. */
  function* buildTileSteps(tx: number, tz: number): Generator<void, Float32Array> {
    const i0 = tx * T - P;
    const j0 = tz * T - P;
    const inf = 1e20;
    for (let bz = Math.floor(j0 / T); bz <= Math.floor((j0 + W - 1) / T); bz++) {
      for (let bx = Math.floor(i0 / T); bx <= Math.floor((i0 + W - 1) / T); bx++) {
        const data = block(bx, bz);
        const ia = Math.max(i0, bx * T);
        const ib = Math.min(i0 + W - 1, bx * T + T - 1);
        const ja = Math.max(j0, bz * T);
        const jb = Math.min(j0 + W - 1, bz * T + T - 1);
        for (let j = ja; j <= jb; j++) {
          for (let i = ia; i <= ib; i++) {
            const land = (data[(j - bz * T) * T + (i - bx * T)] ?? 0) > 0;
            const k = (j - j0) * W + (i - i0);
            toLand[k] = land ? 0 : inf;
            toSea[k] = land ? inf : 0;
          }
        }
      }
    }
    yield* squaredDistanceSteps(toLand, W, TILE_LINES, f, d, v, zz);
    yield* squaredDistanceSteps(toSea, W, TILE_LINES, f, d, v, zz);
    const out = new Float32Array(span * span);
    for (let j = 0; j < span; j++) {
      for (let i = 0; i < span; i++) {
        const k = (j + P) * W + (i + P);
        const value = (toLand[k] ?? 0) > 0 ? Math.sqrt(toLand[k] ?? 0) * cell : -Math.sqrt(toSea[k] ?? 0) * cell;
        out[j * span + i] = Math.max(-saturation, Math.min(saturation, value));
      }
    }
    return out;
  }

  /** The tile being built a slice at a time by `prefetch`. */
  let building: { key: string; tx: number; tz: number; steps: Generator<void, Float32Array> } | null = null;

  function tile(tx: number, tz: number): Float32Array {
    const key = `${String(tx)}:${String(tz)}`;
    let t = tiles.get(key);
    if (!t) {
      // Reading a missing tile builds it now, over the scratch grids a half-built tile was using.
      building = null;
      const steps = buildTileSteps(tx, tz);
      for (;;) {
        const next = steps.next();
        if (next.done) {
          t = next.value;
          break;
        }
      }
    }
    touch(tiles, key, t, maxTiles);
    return t;
  }

  /** Builds the tile a slice at a time until `over`; true once it is built. */
  function stepTile(tx: number, tz: number, over: () => boolean): boolean {
    const key = `${String(tx)}:${String(tz)}`;
    if (building?.key !== key) building = { key, tx, tz, steps: buildTileSteps(tx, tz) };
    for (;;) {
      const next = building.steps.next();
      if (next.done) {
        touch(tiles, key, next.value, maxTiles);
        building = null;
        return true;
      }
      if (over()) return false;
    }
  }

  function distanceAt(x: number, z: number): number {
    const fx = (x - min) / cell;
    const fz = (z - min) / cell;
    if (!Number.isFinite(fx) || !Number.isFinite(fz)) return saturation;
    const tx = Math.floor(fx / T);
    const tz = Math.floor(fz / T);
    const t = tile(tx, tz);
    const lx = Math.min(T - 1e-9, fx - tx * T);
    const lz = Math.min(T - 1e-9, fz - tz * T);
    const x0 = Math.floor(lx);
    const z0 = Math.floor(lz);
    const ax = lx - x0;
    const az = lz - z0;
    const k = z0 * span + x0;
    const a = (t[k] ?? 0) + ((t[k + 1] ?? 0) - (t[k] ?? 0)) * ax;
    const b = (t[k + span] ?? 0) + ((t[k + span + 1] ?? 0) - (t[k + span] ?? 0)) * ax;
    return a + (b - a) * az;
  }

  function maskAway(x: number, z: number): { x: number; z: number } {
    const e = cell * 2;
    const gx = maskAt(x - e, z) - maskAt(x + e, z);
    const gz = maskAt(x, z - e) - maskAt(x, z + e);
    const len = Math.hypot(gx, gz);
    return len > 1e-9 ? { x: gx / len, z: gz / len } : { x: 1, z: 0 };
  }

  return {
    min,
    cell,
    saturation,
    distanceAt,
    clearance(x, z) {
      // Texel centres sit about half a cell either side of the coast.
      return distanceAt(x, z) - cell * 0.5;
    },
    away(x, z) {
      const e = cell;
      const gx = distanceAt(x + e, z) - distanceAt(x - e, z);
      const gz = distanceAt(x, z + e) - distanceAt(x, z - e);
      const len = Math.hypot(gx, gz);
      if (len > 1e-6) return { x: gx / len, z: gz / len };
      // Deep inland or far out at sea the clamped field is flat: fall back to the coast mask's slope.
      return maskAway(x, z);
    },
    ready(x, z) {
      const tx = Math.floor((x - min) / cell / T);
      const tz = Math.floor((z - min) / cell / T);
      return tiles.has(`${String(tx)}:${String(tz)}`);
    },
    prefetch(x, z, radius, budgetMs) {
      const start = now();
      let last = start;
      // Asked after every slice: notes what it took, and says whether the time left would not hold another.
      const over = () => {
        const t = now();
        cost.note(t - last);
        last = t;
        return !cost.fits(budgetMs - (t - start));
      };
      const size = T * cell;
      const fx = (x - min) / size;
      const fz = (z - min) / size;
      const reach = Math.ceil(radius / size);
      const wanted: { tx: number; tz: number; d: number }[] = [];
      for (let tz = Math.floor(fz) - reach; tz <= Math.floor(fz) + reach; tz++) {
        for (let tx = Math.floor(fx) - reach; tx <= Math.floor(fx) + reach; tx++) {
          const d = Math.hypot(tx + 0.5 - fx, tz + 0.5 - fz) * size;
          if (d <= radius + size * 0.71 && !tiles.has(`${String(tx)}:${String(tz)}`)) wanted.push({ tx, tz, d });
        }
      }
      wanted.sort((a, b) => a.d - b.d || a.tz - b.tz || a.tx - b.tx);
      // A tile half built goes first, however the whale has moved since.
      if (building && !tiles.has(building.key)) {
        if (!stepTile(building.tx, building.tz, over)) return false;
      }
      for (const { tx, tz } of wanted) {
        // Fill this tile's blocks a row at a time; the distance transform itself is cheap.
        for (let bz = tz - 1; bz <= tz + 1; bz++) {
          for (let bx = tx - 1; bx <= tx + 1; bx++) {
            const key = `${String(bx)}:${String(bz)}`;
            if (blocks.has(key)) continue;
            if (pending?.key !== key) pending = { key, bx, bz, data: new Float32Array(T * T), row: 0 };
            if (!blockRows(pending, over)) return false;
            touch(blocks, key, pending.data, maxBlocks);
            pending = null;
            if (over()) return false;
          }
        }
        if (!tiles.has(`${String(tx)}:${String(tz)}`) && !stepTile(tx, tz, over)) return false;
        if (over()) return false;
      }
      return true;
    },
    stats() {
      return { tiles: tiles.size, blocks: blocks.size };
    },
  };
}

/** Exact squared Euclidean distance transform (Felzenszwalb–Huttenlocher) of a size² grid, in place. */
export function squaredDistance(
  grid: Float64Array,
  size: number,
  f = new Float64Array(size),
  d = new Float64Array(size),
  v = new Int32Array(size),
  z = new Float64Array(size + 1),
): void {
  const steps = squaredDistanceSteps(grid, size, Infinity, f, d, v, z);
  while (!steps.next().done) {
    // Every slice runs now; the stepped form exists for the streaming budget.
  }
}

/** squaredDistance in slices: yields after every `lines` lines of the row and column passes. */
export function* squaredDistanceSteps(
  grid: Float64Array,
  size: number,
  lines: number,
  f = new Float64Array(size),
  d = new Float64Array(size),
  v = new Int32Array(size),
  z = new Float64Array(size + 1),
): Generator<void> {
  const pass = (offset: number, stride: number) => {
    for (let i = 0; i < size; i++) f[i] = grid[offset + i * stride] ?? 0;
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < size; q++) {
      let s = (((f[q] ?? 0) + q * q) - ((f[v[k] ?? 0] ?? 0) + (v[k] ?? 0) * (v[k] ?? 0))) / (2 * q - 2 * (v[k] ?? 0));
      while (s <= (z[k] ?? 0)) {
        k--;
        s = (((f[q] ?? 0) + q * q) - ((f[v[k] ?? 0] ?? 0) + (v[k] ?? 0) * (v[k] ?? 0))) / (2 * q - 2 * (v[k] ?? 0));
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < size; q++) {
      while ((z[k + 1] ?? 0) < q) k++;
      const dq = q - (v[k] ?? 0);
      d[q] = dq * dq + (f[v[k] ?? 0] ?? 0);
    }
    for (let i = 0; i < size; i++) grid[offset + i * stride] = d[i] ?? 0;
  };
  for (let row = 0; row < size; row++) {
    pass(row * size, 1);
    if (row % lines === lines - 1) yield;
  }
  for (let col = 0; col < size; col++) {
    pass(col, size);
    if (col % lines === lines - 1) yield;
  }
}
