/** Side of the finest land tile in metres; each coarser level doubles it. */
export const CHUNK_SIZE = 128;
/** Side of a ship cell in metres; each cell holds 0–2 ships. */
export const SHIP_CELL = 1024;

export function chunkCoord(w: number, size: number): number {
  return Math.floor(w / size);
}

export function chunkKey(lod: number, cx: number, cz: number): string {
  return `${String(lod)}:${String(cx)}:${String(cz)}`;
}

export function parseChunkKey(key: string): { lod: number; cx: number; cz: number } {
  const [lod, cx, cz] = key.split(':').map(Number);
  if (lod === undefined || cx === undefined || cz === undefined) throw new Error(`Malformed chunk key ${key}`);
  return { lod, cx, cz };
}

/** Distance from (x, z) to the nearest point of a cell (0 inside it). */
export function cellDistance(x: number, z: number, cx: number, cz: number, size: number): number {
  const dx = Math.max(cx * size - x, 0, x - (cx + 1) * size);
  const dz = Math.max(cz * size - z, 0, z - (cz + 1) * size);
  return Math.hypot(dx, dz);
}

/**
 * Cells of `size` within `radius` of (wx, wz), nearest first; ties break on
 * coordinates so the order never depends on anything but the inputs.
 */
export function chunksAround(wx: number, wz: number, radius: number, size: number, lod = 0): string[] {
  const x0 = chunkCoord(wx - radius, size);
  const x1 = chunkCoord(wx + radius, size);
  const z0 = chunkCoord(wz - radius, size);
  const z1 = chunkCoord(wz + radius, size);
  const cells: { cx: number; cz: number; d: number }[] = [];
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      const d = cellDistance(wx, wz, cx, cz, size);
      if (d <= radius) cells.push({ cx, cz, d });
    }
  }
  cells.sort((a, b) => a.d - b.d || a.cz - b.cz || a.cx - b.cx);
  return cells.map((c) => chunkKey(lod, c.cx, c.cz));
}

export interface ChunkStreamer<T> {
  readonly loaded: ReadonlyMap<string, T>;
  /** Loads wanted chunks (nearest first, within the budget) and unloads ones no longer kept. */
  update: (wx: number, wz: number) => void;
  dispose: () => void;
}

export interface ChunkStreamerOptions<T> {
  /** Keys to load around (wx, wz), nearest first. */
  wanted: (wx: number, wz: number) => string[];
  /** Whether a loaded chunk may stay; should accept a wider ring than `wanted` so a boundary never thrashes. */
  keep: (key: string, wx: number, wz: number) => boolean;
  build: (key: string) => T;
  dispose: (item: T, key: string) => void;
  maxBuildsPerFrame?: number;
  /** Stop building once this many milliseconds were spent in one update. */
  budgetMs?: number;
  now?: () => number;
}

export function createChunkStreamer<T>(options: ChunkStreamerOptions<T>): ChunkStreamer<T> {
  const loaded = new Map<string, T>();
  const maxBuilds = options.maxBuildsPerFrame ?? Infinity;
  const now = options.now ?? (() => performance.now());
  return {
    loaded,
    update(wx, wz) {
      for (const [key, item] of loaded) {
        if (!options.keep(key, wx, wz)) {
          loaded.delete(key);
          options.dispose(item, key);
        }
      }
      const start = now();
      let built = 0;
      for (const key of options.wanted(wx, wz)) {
        if (loaded.has(key)) continue;
        if (built >= maxBuilds) break;
        if (options.budgetMs !== undefined && built > 0 && now() - start > options.budgetMs) break;
        loaded.set(key, options.build(key));
        built++;
      }
    },
    dispose() {
      for (const [key, item] of loaded) options.dispose(item, key);
      loaded.clear();
    },
  };
}
