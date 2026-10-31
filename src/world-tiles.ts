import type { NoiseFunction2D } from 'simplex-noise';
import type { Land } from './land.js';
import { CHUNK_SIZE } from './chunks.js';
import { clamp, smoothstep } from './math.js';
import { HERD_CELL, latticeUnit, OBJECT_LEVELS, TOWN_CELL, TREE, TREE_CELL, WALKER_LEVELS, type Biome, type House, type LandLife, type Walker } from './land-life.js';
import type { BufferGeometry } from 'three';
import { cone, house as houseShape, lump, placed, shape, trunk, type Rgb } from './land-objects.js';
import { item } from './item.js';

/**
 * Land tile geometry, a pure function of (land, level, ix, iz, cells). Runs in
 * the land worker and, as a fallback, on the main thread; it must not import
 * three.js so the worker stays small.
 */

/** Coarsest level: tiles of CHUNK_SIZE · 2^TOP_LEVEL metres. */
export const TOP_LEVEL = 6;
/** Sink the land a little so beaches meet the water without a seam. */
export const SINK = 0.7;

export function tileSize(level: number): number {
  return CHUNK_SIZE * 2 ** level;
}

export interface TileData {
  /** Local to the tile's (x0, z0) corner. */
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Rock, sand, forest and object weights per vertex (0 to 255) for the land shader's detail. */
  detail: Uint8Array;
  index: Uint16Array;
  triangles: number;
  /** Trees, rocks and houses baked into the tile, and their triangles. */
  objects: number;
  objectTriangles: number;
  /** People and animals standing on the tile: WALKER_STRIDE floats each (see `Walker`), x and z local to the tile. */
  walkers: Float32Array | null;
  /** Shading maps of a coarse tile (see `MAP_LEVEL`), or null. */
  maps: ShadingMaps | null;
}

/**
 * A coarse tile's surface at twice its vertex density, so far ranges show their spurs, gullies, rock and snow
 * lines instead of the facets of their mesh: `size`² texels over the tile, texel centres at (t + 0.5) / size,
 * colour as sRGB, and the normal (xyz from 0 to 255) with a cavity term in alpha (dark in gullies, light on ridges).
 */
export interface ShadingMaps { size: number; color: Uint8Array; normal: Uint8Array }

/** Tiles from this level up (512 m and more) carry shading maps and a grid finer than the tier's (see `tileCells`). */
export const MAP_LEVEL = 2;
/** Shading map texels per cell of the tier's grid. */
const MAP_DENSITY = 4;
/** Cells of a coarse tile's grid per cell of the tier's: ridgelines and peaks make the skyline, and show their vertices. */
const FINER = 2;

/** Cells per side of a tile at `level` when the tier's grid has `base`. */
export function tileCells(level: number, base: number): number {
  return level >= MAP_LEVEL ? base * FINER : base;
}

/** kind, x, y, z, yaw, range, phase, tint. */
export const WALKER_STRIDE = 8;

/** What a tile needs to carry life: the placement rules and the tier's object cap. */
export interface TileLife { life: LandLife; objects: number }


type Color = [number, number, number];

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hex = (value: number): Rgb => [
  toLinear(((value >> 16) & 255) / 255),
  toLinear(((value >> 8) & 255) / 255),
  toLinear((value & 255) / 255),
];

// A natural palette: sage and olive grass, straw, deep forest, grey-brown rock, as the land reads in photographs
// under a sea sky (lime greens read as a game).
const WET_SAND = hex(0x9c8d6e);
const SAND = hex(0xd3c4a2);
const GRASS = hex(0x667a44);
const MEADOW = hex(0x848a58);
const FOREST = hex(0x34492c);
const DARK_FOREST = hex(0x263a24);
const SCRUB = hex(0x6b694e);
const ROCK = hex(0x78726a);
const CLIFF = hex(0x6a645c);
const CLIFF_PALE = hex(0x8e877c);
const SNOW = hex(0xf0f3f6);
const DRY = hex(0x9e9268);

function mix(out: Color, to: Rgb, t: number): void {
  const u = clamp(t, 0, 1);
  out[0] += (to[0] - out[0]) * u;
  out[1] += (to[1] - out[1]) * u;
  out[2] += (to[2] - out[2]) * u;
}

/** Beach sand weight: flat ground just above the waterline. */
export const sandAt = (height: number, slopeY: number, patch: number): number =>
  (1 - smoothstep(1.8, 3.4, height + patch * 0.6)) * smoothstep(0.75, 0.92, slopeY);

/**
 * Biome colour (linear RGB) from height in metres, slope (normal Y), a patch noise in [−1, 1] and the
 * forest cover (by default a band by height).
 */
export function biomeColor(height: number, slopeY: number, patch: number, out: Color = [0, 0, 0], forest?: number): Color {
  const h = height + patch * 18;
  out[0] = GRASS[0];
  out[1] = GRASS[1];
  out[2] = GRASS[2];
  mix(out, MEADOW, patch * 0.5 + 0.5);
  // Dry, sunlit grass on open ground between the woods.
  mix(out, DRY, smoothstep(0.2, 0.8, patch) * smoothstep(6, 40, height) * 0.45);
  const wood = forest ?? smoothstep(12, 70, h + patch * 25);
  mix(out, FOREST, wood);
  mix(out, DARK_FOREST, smoothstep(90, 220, h) * (0.5 + 0.5 * patch) * (forest === undefined ? 1 : wood));
  mix(out, SCRUB, smoothstep(260, 460, h + patch * 60));
  mix(out, ROCK, smoothstep(460, 720, h + patch * 70));
  const steep = 1 - smoothstep(0.42, 0.66, slopeY);
  // Sea cliffs show layered rock bands rather than one flat tone.
  const strata = 0.5 + 0.18 * Math.sin(height * 0.3 + patch * 2.5);
  const cliffRgb: Color = [CLIFF[0], CLIFF[1], CLIFF[2]];
  mix(cliffRgb, CLIFF_PALE, strata);
  mix(out, height < 90 ? cliffRgb : ROCK, steep);
  const snowline = 640 + patch * 110;
  const snowy = smoothstep(snowline - 60, snowline + 60, height);
  // Snow settles on all but sheer faces, and dusts even those well above the line.
  mix(out, SNOW, Math.max(snowy * smoothstep(0.2, 0.45, slopeY), smoothstep(snowline + 120, snowline + 260, height) * 0.7));
  // Beaches: flat sand at the waterline, darker where wet.
  mix(out, SAND, sandAt(height, slopeY, patch));
  mix(out, WET_SAND, (1 - smoothstep(0.4, 1.0, height)) * smoothstep(0.6, 0.85, slopeY));
  return out;
}

/** Cells under this depth on all four corners are skipped (open sea). */
const DEEP = -1.5;
/** Skirts reach no deeper than this under the sea (m), and at least this far below their edge. */
const SHORE_SKIRT = 2.5;
const B = 2;

/**
 * Builds one tile at `level`, or null when it is all sea. `cells` is the tier's grid; with `fine`, coarse levels
 * refine it (see `tileCells`). The worker builds them fine; the main thread builds the tier's own grid, which it can
 * afford inside its frame budget and before the first frame.
 * Heights are sampled on a two-sample border so the peak limiter and normals
 * agree with the neighbouring tiles of the same level; skirts hide the cracks
 * against other levels. With `extras`, tiles at the finest levels also carry
 * trees, rocks and houses in their geometry and list the walkers on them.
 */
export function buildTile(
  land: Pick<Land, 'surfaceAt' | 'regions'>,
  patchNoise: NoiseFunction2D,
  level: number,
  ix: number,
  iz: number,
  cells: number,
  extras?: TileLife,
  maps = false,
  fine = true,
): TileData | null {
  const N = fine ? tileCells(level, cells) : cells;
  const size = tileSize(level);
  const step = size / N;
  const x0 = ix * size;
  const z0 = iz * size;
  // Equivalent ring of the old clipmap (4 m cells at ring 0): sets fine octaves and far colouring.
  const ring = Math.max(0, Math.round(Math.log2(step / 4)));
  const S = N + 1 + 2 * B;
  const raw = new Float32Array(S * S);
  const cliffs = new Float32Array(S * S);
  const surface = { cliff: 0 };
  let highest = -Infinity;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const k = j * S + i;
      raw[k] = land.surfaceAt(x0 + (i - B) * step, z0 + (j - B) * step, ring, surface);
      cliffs[k] = surface.cliff;
      if (raw[k] > highest) highest = raw[k] ?? 0;
    }
  }
  if (highest < DEEP) return null;

  // Coarse levels sample sparsely; a lone sampled peak becomes a needle. Limit
  // how far a vertex may rise above its neighbours.
  const heights = raw.slice();
  if (ring >= 2) {
    for (let j = 1; j < S - 1; j++) {
      for (let i = 1; i < S - 1; i++) {
        const k = j * S + i;
        const around = ((raw[k - 1] ?? 0) + (raw[k + 1] ?? 0) + (raw[k - S] ?? 0) + (raw[k + S] ?? 0)) * 0.25;
        const limit = around + step * 0.8;
        if ((raw[k] ?? 0) > limit) heights[k] = limit;
      }
    }
  }

  const life = extras && level < OBJECT_LEVELS ? extras : null;
  const biome = extras ? extras.life.biome(land.regions.weightsAt(x0 + size / 2, z0 + size / 2)) : null;
  const forestAt = extras && biome ? (x: number, z: number, h: number, slopeY: number, cliff: number) => extras.life.forestAt(x, z, h, slopeY, cliff, biome) : undefined;
  const count = N + 1;
  const at = (i: number, j: number) => (j + B) * S + (i + B);
  // Grid vertices, then up to 4N skirt vertices.
  const maxVerts = count * count + 4 * count;
  const positions = new Float32Array(maxVerts * 3);
  const normals = new Float32Array(maxVerts * 3);
  const colors = new Float32Array(maxVerts * 3);
  const detail = new Uint8Array(maxVerts * 4);
  const rgb: Color = [0, 0, 0];
  for (let j = 0; j < count; j++) {
    for (let i = 0; i < count; i++) {
      const v = j * count + i;
      const k = at(i, j);
      const h = heights[k] ?? 0;
      positions[v * 3] = i * step;
      positions[v * 3 + 1] = h - SINK;
      positions[v * 3 + 2] = j * step;
      let nx = ((heights[k - 1] ?? 0) - (heights[k + 1] ?? 0)) / (2 * step);
      let nz = ((heights[k - S] ?? 0) - (heights[k + S] ?? 0)) / (2 * step);
      let ny = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
      const wx = x0 + i * step;
      const wz = z0 + j * step;
      const patch = patchNoise(wx / 140, wz / 140) * 0.7 + patchNoise(wx / 37, wz / 37) * 0.3;
      // Coarse cells smear a cliff face over one cell: colour it as a cliff from the land's own cliff map.
      // Far levels are too coarse for per-face rock and snow: colour from a gentler slope
      // so a range reads as one mass with snowy tops, not stripes.
      const slopeY = Math.min(ring >= 3 ? ny + (1 - ny) * 0.6 : ny, 1 - (cliffs[k] ?? 0) * 0.75);
      const forest = forestAt?.(wx, wz, h, slopeY, cliffs[k] ?? 0);
      biomeColor(h, slopeY, patch, rgb, forest);
      colors[v * 3] = rgb[0];
      colors[v * 3 + 1] = rgb[1];
      colors[v * 3 + 2] = rgb[2];
      // Rock detail on cliffs and real faces only: hillsides stay grass.
      detail[v * 4] = Math.round(255 * Math.max(cliffs[k] ?? 0, 1 - smoothstep(0.35, 0.6, slopeY)));
      detail[v * 4 + 1] = Math.round(255 * sandAt(h, slopeY, patch));
      detail[v * 4 + 2] = Math.round(255 * (forest ?? 0));
    }
  }

  const index: number[] = [];
  const emitted = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * count + i;
      const b = a + 1;
      const c = a + count;
      const d = c + 1;
      const y = Math.max(positions[a * 3 + 1] ?? 0, positions[b * 3 + 1] ?? 0, positions[c * 3 + 1] ?? 0, positions[d * 3 + 1] ?? 0) + SINK;
      if (y < DEEP) continue;
      emitted[j * N + i] = 1;
      index.push(a, c, b, b, c, d);
    }
  }
  if (!index.length) return null;

  // Skirts hang below every emitted edge so a coarser neighbour never shows a crack, but never more than
  // SHORE_SKIRT under the sea: below that the opaque ocean hides any crack from above, the seafloor patch covers it
  // from below, and a long skirt would hang into the water as a dark wall.
  const skirt = step * 1.5 + 2;
  const skirtBottom = (y: number) => Math.max(y - skirt, Math.min(y - SHORE_SKIRT, -SHORE_SKIRT));
  let next = count * count;
  const skirtOf = new Map<number, number>();
  const lowered = (v: number): number => {
    let s = skirtOf.get(v);
    if (s === undefined) {
      s = next++;
      skirtOf.set(v, s);
      positions[s * 3] = positions[v * 3] ?? 0;
      positions[s * 3 + 1] = skirtBottom(positions[v * 3 + 1] ?? 0);
      positions[s * 3 + 2] = positions[v * 3 + 2] ?? 0;
      for (let c = 0; c < 3; c++) {
        normals[s * 3 + c] = normals[v * 3 + c] ?? 0;
        colors[s * 3 + c] = colors[v * 3 + c] ?? 0;
      }
      for (let c = 0; c < 4; c++) detail[s * 4 + c] = detail[v * 4 + c] ?? 0;
    }
    return s;
  };
  // Each edge (a → b) is wound so its face points out of the tile.
  const edge = (a: number, b: number) => {
    const la = lowered(a);
    const lb = lowered(b);
    index.push(a, la, b, b, la, lb);
  };
  for (let i = 0; i < N; i++) {
    if (emitted[i]) edge(i + 1, i);
    if (emitted[(N - 1) * N + i]) edge(N * count + i, N * count + i + 1);
  }
  for (let j = 0; j < N; j++) {
    if (emitted[j * N]) edge(j * count, (j + 1) * count);
    if (emitted[j * N + N - 1]) edge((j + 1) * count + N, j * count + N);
  }

  const ground = index.length;
  let objects = 0;
  let walkers: Float32Array | null = null;
  let out: Arrays = { positions: positions.slice(0, next * 3), normals: normals.slice(0, next * 3), colors: colors.slice(0, next * 3), detail: detail.slice(0, next * 4) };
  if (life && biome) {
    // Heights of the drawn surface, on the same two triangles per cell as the index above.
    const groundAt = (lx: number, lz: number): number => {
      const fx = clamp(lx / step, 0, N - 1e-6);
      const fz = clamp(lz / step, 0, N - 1e-6);
      const i = Math.floor(fx);
      const j = Math.floor(fz);
      const u = fx - i;
      const w = fz - j;
      const ha = heights[at(i, j)] ?? 0;
      const hb = heights[at(i + 1, j)] ?? 0;
      const hc = heights[at(i, j + 1)] ?? 0;
      const hd = heights[at(i + 1, j + 1)] ?? 0;
      return u + w <= 1 ? ha + (hb - ha) * u + (hc - ha) * w : hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - w);
    };
    const vertexAt = (lx: number, lz: number) => at(clamp(Math.round(lx / step), 0, N), clamp(Math.round(lz / step), 0, N));
    const baked: BufferGeometry[] = [];
    const houses = housesIn(life.life, x0, z0, size);
    for (const house of houses) {
      const corners = [-1, 1].flatMap((a) => [-1, 1].map((b) => groundAt(house.x - x0 + a * house.width * 0.5, house.z - z0 + b * house.depth * 0.5)));
      const built = houseGeometry(house);
      baked.push(placed(built, house.x - x0, Math.min(...corners) - SINK, house.z - z0, house.yaw, 1));
      built.dispose();
    }
    const trees = treesIn(life.life, biome, level, x0, z0, size, houses, (lx, lz) => {
      const k = vertexAt(lx, lz);
      return { h: groundAt(lx, lz), ny: Math.min(normals[(Math.round(lz / step) * count + Math.round(lx / step)) * 3 + 1] ?? 0, 1 - (cliffs[k] ?? 0) * 0.75), cliff: cliffs[k] ?? 0 };
    });
    // Tiles from about a kilometre out carry half as many: their trees are a pixel or two.
    const room = Math.max(0, (level >= 3 ? life.objects >> 1 : life.objects) - houses.length);
    for (const tree of trees.slice(0, room)) {
      baked.push(placed(treeShape(tree.kind, tree.shade, biome), tree.x - x0, tree.h - SINK, tree.z - z0, tree.yaw, tree.scale));
    }
    objects = houses.length + Math.min(trees.length, room);
    if (baked.length) {
      const objectsGeometry = shape(baked);
      out = appendObjects(out, next, objectsGeometry, index);
      objectsGeometry.dispose();
    }
    if (level < WALKER_LEVELS) {
      const list = walkersIn(life.life, x0, z0, size);
      if (list.length) {
        const packed = new Float32Array(list.length * WALKER_STRIDE);
        walkers = packed;
        list.forEach((w, n) => { packed.set([w.kind, w.x - x0, groundAt(w.x - x0, w.z - z0) - SINK, w.z - z0, w.yaw, w.range, w.phase, w.tint], n * WALKER_STRIDE); });
      }
    }
  }

  return {
    ...dropUnused(out, index),
    triangles: index.length / 3,
    objects,
    objectTriangles: (index.length - ground) / 3,
    walkers,
    maps: maps && level >= MAP_LEVEL ? shadingMaps(land, patchNoise, x0, z0, size, cells * MAP_DENSITY, forestAt) : null,
  };
}

const toSrgb = (c: number): number => Math.round(255 * clamp(c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055, 0, 1));

/** Bakes a tile's shading maps from the heightfield sampled at the texels' own spacing (see `ShadingMaps`). */
function shadingMaps(
  land: Pick<Land, 'surfaceAt'>,
  patchNoise: NoiseFunction2D,
  x0: number,
  z0: number,
  size: number,
  M: number,
  forestAt?: (x: number, z: number, h: number, slopeY: number, cliff: number) => number,
): ShadingMaps {
  const step = size / M;
  const ring = Math.max(0, Math.round(Math.log2(step / 4)));
  // Texel centres with a two-texel border for the normals and the cavity.
  const S = M + 4;
  const heights = new Float32Array(S * S);
  const cliffs = new Float32Array(S * S);
  const surface = { cliff: 0 };
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      heights[j * S + i] = land.surfaceAt(x0 + (i - 1.5) * step, z0 + (j - 1.5) * step, ring, surface);
      cliffs[j * S + i] = surface.cliff;
    }
  }
  const color = new Uint8Array(M * M * 4);
  const normal = new Uint8Array(M * M * 4);
  const rgb: Color = [0, 0, 0];
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      const k = (j + 2) * S + (i + 2);
      const h = heights[k] ?? 0;
      let nx = ((heights[k - 1] ?? 0) - (heights[k + 1] ?? 0)) / (2 * step);
      let nz = ((heights[k - S] ?? 0) - (heights[k + S] ?? 0)) / (2 * step);
      const len = Math.hypot(nx, 1, nz);
      nx /= len;
      nz /= len;
      const ny = 1 / len;
      const wx = x0 + (i + 0.5) * step;
      const wz = z0 + (j + 0.5) * step;
      const patch = patchNoise(wx / 140, wz / 140) * 0.7 + patchNoise(wx / 37, wz / 37) * 0.3;
      const slopeY = Math.min(ny, 1 - (cliffs[k] ?? 0) * 0.75);
      biomeColor(h, slopeY, patch, rgb, forestAt?.(wx, wz, h, slopeY, cliffs[k] ?? 0));
      const t = (j * M + i) * 4;
      color[t] = toSrgb(rgb[0]);
      color[t + 1] = toSrgb(rgb[1]);
      color[t + 2] = toSrgb(rgb[2]);
      color[t + 3] = 255;
      // Height against the ring two texels out, as a slope: positive on ridges and spurs, negative in gullies.
      const around = ((heights[k - 2] ?? 0) + (heights[k + 2] ?? 0) + (heights[k - 2 * S] ?? 0) + (heights[k + 2 * S] ?? 0)) * 0.25;
      normal[t] = Math.round(127.5 + 127.5 * nx);
      normal[t + 1] = Math.round(127.5 + 127.5 * ny);
      normal[t + 2] = Math.round(127.5 + 127.5 * nz);
      normal[t + 3] = Math.round(255 * clamp(0.5 + ((h - around) / (2 * step)) * 1.5, 0, 1));
    }
  }
  return { size: M, color, normal };
}

interface Arrays { positions: Float32Array; normals: Float32Array; colors: Float32Array; detail: Uint8Array }

/**
 * The vertices some triangle uses, in their order, and the index renumbered to them. A coastal tile skips its open-sea
 * cells, and a fine grid would otherwise carry their vertices through the worker, memory and the GPU for nothing.
 */
function dropUnused(vertices: Arrays, index: readonly number[]): Arrays & { index: Uint16Array } {
  const count = vertices.positions.length / 3;
  const slot = new Int32Array(count).fill(-1);
  for (const v of index) slot[v] = 0;
  let kept = 0;
  for (let v = 0; v < count; v++) if (slot[v] === 0) slot[v] = kept++;
  const positions = new Float32Array(kept * 3);
  const normals = new Float32Array(kept * 3);
  const colors = new Float32Array(kept * 3);
  const detail = new Uint8Array(kept * 4);
  for (let v = 0; v < count; v++) {
    const to = slot[v] ?? -1;
    if (to < 0) continue;
    for (let c = 0; c < 3; c++) {
      positions[to * 3 + c] = vertices.positions[v * 3 + c] ?? 0;
      normals[to * 3 + c] = vertices.normals[v * 3 + c] ?? 0;
      colors[to * 3 + c] = vertices.colors[v * 3 + c] ?? 0;
    }
    for (let c = 0; c < 4; c++) detail[to * 4 + c] = vertices.detail[v * 4 + c] ?? 0;
  }
  return { positions, normals, colors, detail, index: Uint16Array.from(index, (v) => slot[v] ?? 0) };
}

/** Unindexed object geometry appended after the `vertices` ground vertices, flagged as objects for the shader. */
function appendObjects(ground: Arrays, vertices: number, objects: BufferGeometry, index: number[]): Arrays {
  const added = objects.getAttribute('position').count;
  const total = vertices + added;
  const grow = <T extends Float32Array | Uint8Array>(from: T, make: (n: number) => T, n: number) => {
    const to = make(total * n);
    to.set(from);
    return to;
  };
  const positions = grow(ground.positions, (n) => new Float32Array(n), 3);
  const normals = grow(ground.normals, (n) => new Float32Array(n), 3);
  const colors = grow(ground.colors, (n) => new Float32Array(n), 3);
  const detail = grow(ground.detail, (n) => new Uint8Array(n), 4);
  positions.set(objects.getAttribute('position').array, vertices * 3);
  normals.set(objects.getAttribute('normal').array, vertices * 3);
  colors.set(objects.getAttribute('color').array, vertices * 3);
  for (let v = vertices; v < total; v++) detail[v * 4 + 3] = 255;
  for (let v = vertices; v < total; v++) index.push(v);
  return { positions, normals, colors, detail };
}

/** Houses of the towns whose centre lies within reach of the tile, standing in it. */
function housesIn(life: LandLife, x0: number, z0: number, size: number): House[] {
  const out: House[] = [];
  for (let cj = Math.floor((z0 - 200) / TOWN_CELL); cj <= Math.floor((z0 + size + 200) / TOWN_CELL); cj++) {
    for (let ci = Math.floor((x0 - 200) / TOWN_CELL); ci <= Math.floor((x0 + size + 200) / TOWN_CELL); ci++) {
      for (const house of life.town(ci, cj)?.houses ?? []) {
        if (house.x >= x0 && house.x < x0 + size && house.z >= z0 && house.z < z0 + size) out.push(house);
      }
    }
  }
  return out;
}

function walkersIn(life: LandLife, x0: number, z0: number, size: number): Walker[] {
  const out: Walker[] = [];
  const inside = (w: Walker) => w.x >= x0 && w.x < x0 + size && w.z >= z0 && w.z < z0 + size;
  for (let cj = Math.floor((z0 - 200) / TOWN_CELL); cj <= Math.floor((z0 + size + 200) / TOWN_CELL); cj++) {
    for (let ci = Math.floor((x0 - 200) / TOWN_CELL); ci <= Math.floor((x0 + size + 200) / TOWN_CELL); ci++) {
      for (const person of life.town(ci, cj)?.people ?? []) if (inside(person)) out.push(person);
    }
  }
  for (let hj = Math.floor((z0 - 40) / HERD_CELL); hj <= Math.floor((z0 + size + 40) / HERD_CELL); hj++) {
    for (let hi = Math.floor((x0 - 40) / HERD_CELL); hi <= Math.floor((x0 + size + 40) / HERD_CELL); hi++) {
      for (const animal of life.herd(hi, hj)) if (inside(animal)) out.push(animal);
    }
  }
  return out;
}

interface Tree { kind: number; x: number; z: number; h: number; yaw: number; scale: number; shade: number; rank: number }

/** Lattice salts. */
const SALT_RANK = 0x7472;
const SALT_JITTER = 0x746a;

/**
 * Trees, shrubs and boulders of a tile, best first. Every lattice point has a
 * rank; a tile at `level` only considers the points ranked under 3^−level,
 * and a point is kept where its rank relative to that is under the local
 * density, so a coarse tile holds a sparser subset of its children's trees.
 */
export function treesIn(
  life: LandLife,
  biome: Biome,
  level: number,
  x0: number,
  z0: number,
  size: number,
  houses: readonly House[],
  ground: (lx: number, lz: number) => { h: number; ny: number; cliff: number },
): Tree[] {
  const seed = life.seed;
  const keep = 3 ** -level;
  const out: Tree[] = [];
  const g0 = Math.round(x0 / TREE_CELL);
  const h0 = Math.round(z0 / TREE_CELL);
  const n = Math.round(size / TREE_CELL);
  for (let gj = h0; gj < h0 + n; gj++) {
    for (let gi = g0; gi < g0 + n; gi++) {
      const rank = latticeUnit(seed, SALT_RANK, gi, gj);
      if (rank >= keep) continue;
      const v = rank / keep;
      const x = (gi + 0.15 + 0.7 * latticeUnit(seed, SALT_JITTER, gi, gj)) * TREE_CELL;
      const z = (gj + 0.15 + 0.7 * latticeUnit(seed, SALT_JITTER + 1, gi, gj)) * TREE_CELL;
      const { h, ny, cliff } = ground(x - x0, z - z0);
      if (h < 1.2) continue;
      if (houses.some((house) => Math.hypot(house.x - x, house.z - z) < 8)) continue;
      const pick = latticeUnit(seed, SALT_JITTER + 2, gi, gj);
      const forest = life.forestAt(x, z, h, ny, cliff, biome);
      const rock = Math.max(cliff, 1 - smoothstep(0.55, 0.85, ny));
      const palms = biome.tropical * 0.3 * smoothstep(2.2, 3, h) * (1 - smoothstep(9, 16, h)) * smoothstep(0.8, 0.9, ny);
      const lone = 0.025 * smoothstep(4, 12, h) * (1 - smoothstep(biome.treeline * 0.5, biome.treeline * 0.8, h)) * (1 - rock);
      const trees = Math.max(forest, lone);
      const shrubs = level <= 2 ? 0.05 * smoothstep(3, 8, h) * (1 - smoothstep(biome.treeline, biome.treeline * 1.3, h)) * (1 - rock) : 0;
      const boulders = level <= 2 ? 0.08 * rock * smoothstep(0.3, 1.5, h) + 0.05 * smoothstep(0.02, 0.2, cliff) * (1 - smoothstep(3, 5, h)) : 0;
      let kind: number;
      if (v < palms) kind = TREE.palm;
      else if (v < palms + trees) {
        const conifer = Math.min(1, biome.polar + smoothstep(140, 330, h) * (1 - biome.tropical));
        kind = pick < conifer ? TREE.conifer : TREE.broadleaf;
      } else if (v < palms + trees + shrubs) kind = TREE.shrub;
      else if (v < palms + trees + shrubs + boulders) kind = TREE.boulder;
      else continue;
      out.push({ kind, x, z, h, yaw: pick * 40, scale: 0.75 + 0.55 * latticeUnit(seed, SALT_JITTER + 3, gi, gj), shade: latticeUnit(seed, SALT_JITTER + 4, gi, gj), rank });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

const TRUNK = hex(0x5b4834);
const PALM_TRUNK = hex(0x8a7556);
const LEAVES: Record<number, readonly Rgb[]> = {
  [TREE.conifer]: [hex(0x2c4a2c), hex(0x34502e), hex(0x27412f)],
  [TREE.broadleaf]: [hex(0x4d6b2d), hex(0x5c7834), hex(0x44622c), hex(0x6a7a36)],
  [TREE.palm]: [hex(0x5f8a38), hex(0x6c9440)],
  [TREE.shrub]: [hex(0x55703a), hex(0x627a3e), hex(0x6e7444)],
  [TREE.boulder]: [hex(0x8a857b), hex(0x7b766d), hex(0x958e80)],
};

const scaled = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

/** Tree, shrub and boulder shapes at unit scale, built once per kind, colour and biome tone. */
const trees = new Map<string, BufferGeometry>();

function treeShape(kind: number, shade: number, biome: Biome): BufferGeometry {
  const palette = item(LEAVES, kind);
  const pick = Math.floor(shade * palette.length) % palette.length;
  const polar = biome.polar > 0.5;
  const key = `${String(kind)}:${String(pick)}:${String(polar)}`;
  const known = trees.get(key);
  if (known) return known;
  const leaf = item(palette, pick);
  // Polar woods are darker and bluer.
  const tone: Rgb = polar ? [leaf[0] * 0.85, leaf[1] * 0.9, leaf[2] * 1.05] : leaf;
  const under = scaled(tone, 0.78);
  let parts: BufferGeometry[];
  if (kind === TREE.conifer) {
    parts = [trunk(3, 0.35, 0.3, -0.5, 1.4, { color: TRUNK }), cone(6, 2.6, 1, 6.8, { color: tone, foot: under }), cone(6, 1.9, 4.4, 6.2, { color: tone, turn: 0.5 })];
  } else if (kind === TREE.broadleaf) {
    parts = [trunk(3, 0.38, 0.3, -0.5, 2.8, { color: TRUNK }), lump(3.3, 1.9, 6, { color: tone, foot: under })];
  } else if (kind === TREE.palm) {
    // A closed, flat crown: the camera at sea level sees it from below.
    parts = [trunk(3, 0.32, 0.22, -0.5, 8.4, { color: PALM_TRUNK }), cone(7, 4.1, 7.1, 1.8, { color: tone, foot: under }, true)];
  } else if (kind === TREE.shrub) {
    parts = [lump(1.4, -0.2, 1.9, { color: tone, foot: under })];
  } else {
    parts = [lump(1.7, -0.6, 2, { color: tone, foot: scaled(tone, 0.85) })];
  }
  const built = shape(parts);
  trees.set(key, built);
  return built;
}

const TOWER_ROOF = 0x4c5158;

function houseGeometry(h: House): BufferGeometry {
  // Walls reach below the lowest corner so a house never floats on a slope.
  return houseShape(h.width, h.depth, h.height, -1.5, hex(h.wall), hex(h.tower ? TOWER_ROOF : h.roof), h.tower);
}
