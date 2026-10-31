import { trimOldest } from './bounded.js';

/**
 * Metres to the nearest land of any kind (continents, islands, islets and rocks), out to `reach`: what the ocean's
 * depth needs, since island flanks fall to the abyssal plain within about that distance. The land mask is sampled on
 * a coarse lattice in tiles, each padded by `reach` so its distance transform is exact out to there, and clamped
 * beyond. A tile is a pure function of its coordinates; tiles near the whale are built ahead in idle time.
 */

export interface DepthField {
  /** Metres to the nearest land at world X/Z: 0 on land, at most `reach`. */
  coastDistanceAt: (x: number, z: number) => number;
  /** Builds the tiles around world X/Z ahead of need for up to `budgetMs`; true when there is nothing left to build. */
  prefetch: (x: number, z: number, budgetMs?: number) => boolean;
  readonly reach: number;
  stats: () => { tiles: number };
}

export interface DepthFieldOptions {
  /** Lattice spacing (m). */
  cell?: number;
  /** Cells per tile side. */
  tile?: number;
  /** Distance known exactly out to this many metres. */
  reach?: number;
  /** Mask value above which a lattice point counts as land (the mask is about 1 per 500 m near a coast). */
  landAbove?: number;
  maxTiles?: number;
  now?: () => number;
}

const INF = 1e20;

/** 1D squared Euclidean distance transform (Felzenszwalb and Huttenlocher) of `f` into `d`, `n` samples. */
function edt1(f: Float64Array, d: Float64Array, n: number, v: Int32Array, zb: Float64Array): void {
  let k = 0;
  v[0] = 0;
  zb[0] = -INF;
  zb[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] ?? 0) + q * q - ((f[v[k] ?? 0] ?? 0) + (v[k] ?? 0) * (v[k] ?? 0))) / (2 * q - 2 * (v[k] ?? 0));
    while (s <= (zb[k] ?? 0)) {
      k--;
      s = ((f[q] ?? 0) + q * q - ((f[v[k] ?? 0] ?? 0) + (v[k] ?? 0) * (v[k] ?? 0))) / (2 * q - 2 * (v[k] ?? 0));
    }
    k++;
    v[k] = q;
    zb[k] = s;
    zb[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while ((zb[k + 1] ?? 0) < q) k++;
    d[q] = (q - (v[k] ?? 0)) ** 2 + (f[v[k] ?? 0] ?? 0);
  }
}

export function createDepthField(maskAt: (x: number, z: number) => number, options: DepthFieldOptions = {}): DepthField {
  const cell = options.cell ?? 250;
  const T = options.tile ?? 64;
  const reach = options.reach ?? 14000;
  const landAbove = options.landAbove ?? -0.4;
  const maxTiles = options.maxTiles ?? 36;
  const now = options.now ?? (() => performance.now());
  const P = Math.ceil(reach / cell);
  const W = T + 2 * P + 1;
  const tiles = new Map<string, Float32Array>();
  // Scratch for the transform.
  const grid = new Float64Array(W * W);
  const f = new Float64Array(W);
  const d = new Float64Array(W);
  const v = new Int32Array(W);
  const zb = new Float64Array(W + 1);

  /** Builds a tile in slices: yields after every few rows of mask samples, so a prefetch never holds up a frame. */
  function* build(tx: number, tz: number): Generator<void, Float32Array> {
    const x0 = (tx * T - P) * cell;
    const z0 = (tz * T - P) * cell;
    // The mask goes into its own buffer: the transform's scratch is shared, so it runs in one go at the end.
    const mask = new Uint8Array(W * W);
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) mask[j * W + i] = maskAt(x0 + i * cell, z0 + j * cell) > landAbove ? 1 : 0;
      if (j % 8 === 7) yield;
    }
    for (let k = 0; k < W * W; k++) grid[k] = mask[k] ? 0 : INF;
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) f[i] = grid[j * W + i] ?? 0;
      edt1(f, d, W, v, zb);
      for (let i = 0; i < W; i++) grid[j * W + i] = d[i] ?? 0;
    }
    for (let i = 0; i < W; i++) {
      for (let j = 0; j < W; j++) f[j] = grid[j * W + i] ?? 0;
      edt1(f, d, W, v, zb);
      for (let j = 0; j < W; j++) grid[j * W + i] = d[j] ?? 0;
    }
    const out = new Float32Array((T + 1) * (T + 1));
    for (let j = 0; j <= T; j++) {
      for (let i = 0; i <= T; i++) out[j * (T + 1) + i] = Math.min(reach, Math.sqrt(grid[(j + P) * W + i + P] ?? 0) * cell);
    }
    trimOldest(tiles, maxTiles - 1);
    tiles.set(`${String(tx)},${String(tz)}`, out);
    return out;
  }

  /** The tile being built ahead of need, if any. */
  let pending: { key: string; steps: Generator<void, Float32Array> } | null = null;
  const finish = (steps: Generator<void, Float32Array>): Float32Array => {
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
    }
  };

  function tileAt(tx: number, tz: number): Float32Array {
    const key = `${String(tx)},${String(tz)}`;
    const hit = tiles.get(key);
    if (hit) {
      // Most recently used goes last.
      tiles.delete(key);
      tiles.set(key, hit);
      return hit;
    }
    // Needed now: finish it here (taking over a prefetch of the same tile).
    if (pending?.key === key) {
      const steps = pending.steps;
      pending = null;
      return finish(steps);
    }
    return finish(build(tx, tz));
  }

  return {
    reach,
    coastDistanceAt(x, z) {
      const fx = x / cell;
      const fz = z / cell;
      if (!Number.isFinite(fx) || !Number.isFinite(fz)) return reach;
      const tx = Math.floor(fx / T);
      const tz = Math.floor(fz / T);
      const data = tileAt(tx, tz);
      const lx = fx - tx * T;
      const lz = fz - tz * T;
      const i = Math.min(T - 1, Math.floor(lx));
      const j = Math.min(T - 1, Math.floor(lz));
      const u = lx - i;
      const w = lz - j;
      const k = j * (T + 1) + i;
      const a = (data[k] ?? 0) + ((data[k + 1] ?? 0) - (data[k] ?? 0)) * u;
      const b = (data[k + T + 1] ?? 0) + ((data[k + T + 2] ?? 0) - (data[k + T + 1] ?? 0)) * u;
      return a + (b - a) * w;
    },
    prefetch(x, z, budgetMs = 2) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return true;
      const start = now();
      const tx = Math.floor(x / cell / T);
      const tz = Math.floor(z / cell / T);
      while (now() - start < budgetMs) {
        if (!pending) {
          let next: [number, number] | null = null;
          for (let dz = -1; dz <= 1 && !next; dz++) {
            for (let dx = -1; dx <= 1 && !next; dx++) if (!tiles.has(`${String(tx + dx)},${String(tz + dz)}`)) next = [tx + dx, tz + dz];
          }
          if (!next) return true;
          pending = { key: `${String(next[0])},${String(next[1])}`, steps: build(next[0], next[1]) };
        }
        if (pending.steps.next().done) pending = null;
      }
      return false;
    },
    stats: () => ({ tiles: tiles.size }),
  };
}
