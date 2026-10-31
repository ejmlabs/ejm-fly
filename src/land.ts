import type { NoiseFunction2D } from 'simplex-noise';
import { fbm2, makeNoise2D, ridged2 } from './noise.js';
import { hash } from './rng.js';
import { clamp, smoothstep } from './math.js';
import { COAST_SLOPE, MACRO_FLOOR, MACRO_OPEN, createPlanet, type Planet } from './planet.js';
import type { Shore } from './shore.js';
import { createLandmarks, type Landmarks } from './landmarks.js';
import { createRegions, blendLook, type RegionWeights, type Regions } from './regions.js';
import { createNavField, squaredDistance, type NavField } from './world-nav.js';
import { seabedDepth } from './bathymetry.js';
import { createDepthField } from './depth-field.js';

/**
 * Earth-like land for one seed: continents and archipelagos from the planet's
 * layout, fractal coasts with headlands and bays, offshore islets, beaches, cliffs,
 * rolling hills and ridged mountain ranges. Heights are metres above sea level;
 * negative values are sea depth.
 */
export type Land = Shore & {
  seed: number;
  regions: Regions;
  /** Planet-scale layout: continents, oceans, the migration's lane and its heading. */
  planet: Planet;
  /** Rocks and islets spaced across the sea. */
  landmarks: Landmarks;
  /** Centre of the landmass kept in view (world XZ). */
  anchor: { x: number; z: number };
  /** Signed coast field: > 0 on land, < 0 at sea. Cheap compared with heightAt. */
  maskAt: (x: number, z: number) => number;
  heightAt: (x: number, z: number, lod?: number) => number;
  /** Bathymetric depth (metres, ≥ 0) at world X/Z: the shelf, slope and abyssal plain by distance from the coast. */
  depthAt: (x: number, z: number) => number;
  /** Builds the depth field around world X/Z ahead of need for up to `budgetMs`; true when nothing is left to build. */
  prefetchDepth: (x: number, z: number, budgetMs?: number) => boolean;
  /** heightAt that also reports how much of a sea-cliff face the point is on, in [0, 1]. */
  surfaceAt: (x: number, z: number, lod: number, out: { cliff: number }) => number;
  /** Submerged sand banks in [0, 1]: visual only, they never block navigation. */
  shoalAt: (x: number, z: number) => number;
  /** Sampled grid around the start (built on first use) for the opening's shallow-water map. */
  readonly grid: LandGrid;
  /** Navigation field valid anywhere; clearance and away read it. */
  nav: NavField;
  /** Continent offset found for the opening view; pass it back to rebuild the same land cheaply. */
  offset: { x: number; z: number };
  viewYaw: number;
};

export interface LandGrid {
  /** World X/Z of texel (0, 0) centre. */
  min: number;
  cell: number;
  size: number;
  /** Signed coast mask per texel. */
  mask: Float32Array;
  /** Signed distance to the coast in metres: > 0 at sea, < 0 on land. */
  distance: Float32Array;
}

export interface LandOptions {
  /** Camera yaw the main view looks along; land is anchored ahead of it. */
  viewYaw: number;
  /** Navigation / shallow grid resolution (texels per side). */
  gridSize?: number | undefined;
  /** Half-extent of the navigation grid in metres. */
  gridExtent?: number;
  /** Skip the opening search and use this continent offset (from `land.offset`). */
  offset?: { x: number; z: number };
  /** False leaves out the rocks and islets of the open sea (tests compare against it). */
  landmarks?: boolean;
}

/** The planet's layout takes over the mask from the first radius and wholly by the second (the opening view's coast lies within 2 km). */
export const REGION_FROM = 2200;
export const REGION_FULL = 5000;
/** The coast detail only appears where the macro mask is above its floor: within this many metres of a planet coast. */
const COAST_DETAIL_REACH = -MACRO_FLOOR / COAST_SLOPE;
/** The domain warp moves points up to about this far, so world and planet distances differ by at most twice it. */
const WARP_REACH = 2 * 1300;

/** Half-width of the full-depth exit channel from the opening bay, and the mask value it holds the sea to (tens of metres deep). */
const EXIT_WIDTH = 180;
const EXIT_FLOOR = -0.8;

/** Open water is kept around the origin so the whale and ships have room. */
export const HARBOUR_RADIUS = 260;

/**
 * How much the coast distance varies across view bearings, ignoring the single
 * nearest and farthest so one stray bearing cannot fake a receding coast.
 */
export function coastSpread(hits: readonly number[]): number {
  const sorted = [...hits].sort((a, b) => a - b);
  return (sorted[sorted.length - 2] ?? 0) - (sorted[1] ?? 0);
}

/** Bearings either side of the view scored for composition (fits a portrait frame). */
export const VIEW_HALF_CONE = (24 * Math.PI) / 180;
const COAST_SEARCH = 3000;

/** Sea depth for a negative mask: a shallow shelf, then a drop to open ocean. */
export function depthForMask(mask: number, steep = 0): number {
  if (mask >= 0) return 0;
  const s = -mask;
  // Coast masks change ~0.002 per metre: a sandy shelf runs a few hundred metres out.
  const shelf = 14 + 90 * steep;
  return s * shelf + Math.max(0, s - 0.45) * 260;
}

interface Channels {
  warpA: NoiseFunction2D;
  warpB: NoiseFunction2D;
  continent: NoiseFunction2D;
  coast: NoiseFunction2D;
  bay: NoiseFunction2D;
  shoal: NoiseFunction2D;
  islet: NoiseFunction2D;
  cliff: NoiseFunction2D;
  hill: NoiseFunction2D;
  ridge: NoiseFunction2D;
  range: NoiseFunction2D;
  gully: NoiseFunction2D;
  erode: NoiseFunction2D;
}

function channels(seed: number): Channels {
  const s = hash(seed, 'land');
  return {
    warpA: makeNoise2D(s, 1),
    warpB: makeNoise2D(s, 2),
    continent: makeNoise2D(s, 3),
    coast: makeNoise2D(s, 4),
    islet: makeNoise2D(s, 5),
    cliff: makeNoise2D(s, 6),
    hill: makeNoise2D(s, 7),
    ridge: makeNoise2D(s, 8),
    range: makeNoise2D(s, 9),
    bay: makeNoise2D(s, 10),
    shoal: makeNoise2D(s, 11),
    gully: makeNoise2D(s, 12),
    erode: makeNoise2D(s, 13),
  };
}

export function createLand(seed: number, options: LandOptions): Land {
  const n = channels(seed);
  // A landmark stands only in open water: no natural coast within a kilometre, so it never narrows a way through.
  const landmarks = createLandmarks(seed, options.landmarks === false ? () => false : (mark) => {
    const saved = { held, lifted, raised, headland, wx, wz };
    let open = true;
    for (const ring of [0, 400, 1000]) {
      const around = ring === 0 ? 1 : 16;
      for (let k = 0; k < around && open; k++) {
        const x = mark.x + Math.cos((k / around) * Math.PI * 2) * ring;
        const z = mark.z + Math.sin((k / around) * Math.PI * 2) * ring;
        warp(x, z);
        if (maskWarped(x, z) > -0.05) open = false;
      }
    }
    ({ held, lifted, raised, headland, wx, wz } = saved);
    return open;
  });
  const blend: RegionWeights = [0, 0, 0, 0];
  const jitter = (hash(seed, 'land-anchor') / 0x100000000 - 0.5) * 0.7;
  const anchorYaw = options.viewYaw + jitter;
  const anchorDist = 1700 + (hash(seed, 'land-anchor-dist') / 0x100000000) * 500;
  // Camera look convention: (−sin, −cos).
  const look = { x: -Math.sin(options.viewYaw), z: -Math.cos(options.viewYaw) };
  const anchor = { x: -Math.sin(anchorYaw) * anchorDist, z: -Math.cos(anchorYaw) * anchorDist };
  const anchorR2 = 1100 * 1100;
  const bankYaw = options.viewYaw + (hash(seed, 'land-bank') / 0x100000000 - 0.5) * 0.5;
  const bankDist = 110 + (hash(seed, 'land-bank-dist') / 0x100000000) * 90;
  // One channel of open water leaves the opening bay to the side of the view, so no start sea is closed in.
  const exitSide = hash(seed, 'land-exit') & 1 ? 1 : -1;
  const exitTurn = exitSide * (0.95 + (hash(seed, 'land-exit-turn') / 0x100000000) * 0.6);
  const exit = { x: look.x * Math.cos(exitTurn) - look.z * Math.sin(exitTurn), z: look.x * Math.sin(exitTurn) + look.z * Math.cos(exitTurn) };
  const bank = { x: -Math.sin(bankYaw) * bankDist, z: -Math.cos(bankYaw) * bankDist, r: 60 };
  // The migration leaves by the exit and follows the current from there.
  const planet = createPlanet(seed, Math.atan2(exit.z, -exit.x));
  const regions = createRegions(planet);

  // Domain-warped coordinates shared by the mask and the mountains.
  // (ox, oz) slides the continents so the camera starts in a natural bay.
  let ox = 0;
  let oz = 0;
  let wx = 0;
  let wz = 0;
  function warp(x: number, z: number): void {
    const px = x + ox;
    const pz = z + oz;
    const qx = fbm2(n.warpA, px / 3000, pz / 3000, 3);
    const qz = fbm2(n.warpB, px / 3000 + 5.2, pz / 3000 + 1.3, 3);
    wx = px + qx * 1300;
    wz = pz + qz * 1300;
  }

  function rawMask(): number {
    const continent = fbm2(n.continent, wx / 6500, wz / 6500, 5, 2.0, 0.5);
    // Bay-scale and cove-scale octaves give headlands, bays and coves.
    const bay = fbm2(n.bay, wx / 1500, wz / 1500, 3, 2.1, 0.5);
    const coast = fbm2(n.coast, wx / 560, wz / 560, 5, 2.07, 0.52);
    headland = bay;
    return continent * 1.05 + bay * 0.3 + coast * 0.3 - 0.03;
  }

  let held = 0;
  let lifted = 0;
  // The lift a landmark added to the last mask sample: a low islet or rock, not the start of a hill.
  let raised = 0;
  // Bay-scale octave of the last mask sample: high where land juts out as a headland.
  let headland = 0;
  function maskWarped(x: number, z: number): number {
    const r = Math.hypot(x, z);
    const ax = x - anchor.x;
    const az = z - anchor.z;
    held = 0.28 * Math.exp(-(ax * ax + az * az) / anchorR2);
    // A ragged clearing, not a round bowl: its radius wanders with noise.
    const reach = HARBOUR_RADIUS * (1 + 0.35 * fbm2(n.islet, x / 700 + 9.1, z / 700 - 4.2, 2));
    const harbour = 0.3 * (1 - smoothstep(reach, reach + 260, r));
    // Far land rises toward the horizon ahead, so a second, hazier range sits behind the coast.
    const ahead = r > 1 ? (x * look.x + z * look.z) / r : 0;
    // Bounded to the start area: out on the journey the continents speak for themselves.
    const distant = 0.32 * smoothstep(3600, 5400, r) * smoothstep(0.25, 0.8, ahead) * (1 - smoothstep(9000, 14000, r));
    // Away from the opening the planet's layout decides: continents, open ocean and archipelagos.
    const thin = smoothstep(REGION_FROM, REGION_FULL, r);
    let isletGain = 1;
    // Along the exit the mask is held at sea, easing out to nothing at the far end.
    let channel = 0;
    if (r > 450 && r < REGION_FULL + 2000) {
      const along = x * exit.x + z * exit.z;
      if (along > 0) {
        const across = Math.abs(x * -exit.z + z * exit.x);
        channel = (1 - smoothstep(EXIT_WIDTH, EXIT_WIDTH * 2.3, across)) * smoothstep(450, 800, r) * (1 - smoothstep(REGION_FULL, REGION_FULL + 2000, r));
      }
    }
    const macro = thin > 0 ? planet.macroAt(wx - ox, wz - oz) : 0;
    // The coast detail: none in the open ocean, where nothing it adds could reach the surface.
    const coast = thin < 1 ? 1 : smoothstep(MACRO_FLOOR, MACRO_OPEN, macro);
    let detail = 0;
    if (coast > 0) detail = rawMask();
    else headland = 0;
    let m = detail * (1 - thin + thin * coast) + thin * macro + held + distant - harbour;
    if (channel > 0) m += (Math.min(m, EXIT_FLOOR) - m) * channel;
    if (thin > 0) {
      regions.weightsAt(x, z, blend);
      isletGain = 1 + thin * (blendLook(blend, (look) => look.isletGain) - 1);
    }
    // Offshore islets: blobs that only rise in the water off the coast.
    const isl = fbm2(n.islet, x / 340, z / 340, 2);
    const band =
      smoothstep(-0.45, -0.15, m) * (1 - smoothstep(-0.04, 0.06, m)) * smoothstep(HARBOUR_RADIUS + 40, HARBOUR_RADIUS + 140, r);
    lifted = Math.max(0, isl - 0.36) * 1.5 * band * isletGain;
    // A rock or islet of the cell, ragged by the same noise; none in the opening, where the view is composed.
    raised = thin > 0 ? landmarks.at(x, z, isletGain) * thin * (0.9 + 0.35 * isl) : 0;
    m += lifted + raised;
    return m;
  }

  /** Composition of the opening view: an oblique coast, a far side, an islet. */
  function viewScore(): number {
    let wettest = -Infinity;
    for (let ring = 0; ring < 3; ring++) {
      const r = ring * 130;
      for (let a = 0; a < (ring === 0 ? 1 : 8); a++) {
        const t = (a / 8) * Math.PI * 2;
        warp(Math.cos(t) * r, Math.sin(t) * r);
        wettest = Math.max(wettest, maskWarped(Math.cos(t) * r, Math.sin(t) * r));
      }
    }
    const hits: number[] = [];
    let islets = 0;
    let cliffs = 0;
    for (let b = 0; b < 9; b++) {
      const yaw = options.viewYaw + (b / 8 - 0.5) * 2 * VIEW_HALF_CONE;
      const dx = -Math.sin(yaw);
      const dz = -Math.cos(yaw);
      let hit = COAST_SEARCH;
      let left = -1;
      for (let d = 160; d < COAST_SEARCH; d += 40) {
        warp(dx * d, dz * d);
        const land = maskWarped(dx * d, dz * d) > 0;
        if (land && hit === COAST_SEARCH) {
          hit = d;
          if (d < 2200) cliffs = Math.max(cliffs, cliffiness(dx * d, dz * d));
        }
        if (!land && hit < COAST_SEARCH && left < 0) left = d;
        if (left > 0) {
          if (land && hit < 1100) islets++;
          if (land || d > left + 240) break;
        }
      }
      hits.push(hit);
    }
    const near = Math.min(...hits);
    const spread = coastSpread(hits);
    const landed = hits.filter((h) => h < COAST_SEARCH).length;
    return (
      Math.max(0, wettest + 0.05) * 20 +
      Math.max(0, 320 - near) / 200 +
      Math.max(0, near - 750) / 400 +
      Math.max(0, 900 - spread) / 300 +
      Math.max(0, 4 - landed) * 0.4 +
      (islets > 0 ? 0 : 0.35) +
      // At least one cliffed headland on the visible coast.
      Math.max(0, 0.6 - cliffs) * 0.6
    );
  }

  if (options.offset) {
    ox = options.offset.x;
    oz = options.offset.z;
  } else {
    let best = { x: 0, z: 0, score: Infinity };
    for (let k = 0; k < 160; k++) {
      ox = (hash(seed, 'land-offset-x', k) / 0x100000000 - 0.5) * 60000;
      oz = (hash(seed, 'land-offset-z', k) / 0x100000000 - 0.5) * 60000;
      const score = viewScore();
      if (score < best.score) best = { x: ox, z: oz, score };
      if (score <= 0) break;
    }
    ox = best.x;
    oz = best.z;
    // The search tried many offsets; what it decided about landmarks was for those.
    landmarks.reset();
  }

  function maskAt(x: number, z: number): number {
    warp(x, z);
    return maskWarped(x, z);
  }

  /** Cliff strength; reads the headland term of the last mask sample, so call it right after one. */
  function cliffiness(x: number, z: number): number {
    const cape = smoothstep(0.02, 0.35, headland) * 0.3;
    return smoothstep(0.45, 0.75, fbm2(n.cliff, x / 800, z / 800, 2) * 0.5 + 0.5 + cape);
  }

  const scratch = { cliff: 0 };

  /** `lod` > 0 drops fine octaves for the coarse far rings. */
  function surfaceAt(x: number, z: number, lod: number, out: { cliff: number }): number {
    warp(x, z);
    const m = maskWarped(x, z);
    const steep = cliffiness(x, z);
    // The face runs from the waterline up to the plateau edge.
    out.cliff = steep * smoothstep(-0.03, 0.0, m) * (1 - smoothstep(0.07, 0.12, m));
    if (m < 0) return -depthForMask(m, steep);
    const fine = Math.max(2, 5 - Math.floor(lod / 2));
    // Beach: a wide sandy strip that cliffs cut through.
    const beach = 2.3 * smoothstep(0, 0.1, m);
    // Coastal lowland: a low plain behind the beach before the land climbs inland.
    // Islets stay low: their lift raises a beach and a knoll, not a hill range.
    const rise = m - lifted * 0.85 - raised * 0.9;
    const gentle = beach + smoothstep(0.1, 0.3, rise) * 7 + Math.max(0, rise - 0.3) * 190;
    // Cliffs step up to a low headland plateau, then follow the land inland.
    const cliffTop = smoothstep(0, 0.08, m) * (8 + 42 * steep) + Math.max(0, rise - 0.3) * 190;
    let h = gentle + (cliffTop - gentle) * steep;
    const inland = smoothstep(0.25, 0.65, rise);
    const natural = m - held - lifted - raised;
    // Hills on warped, low-frequency coordinates merge into ridges that grow inland.
    const hill = fbm2(n.hill, wx / 1300, wz / 1300, fine) * 0.5 + 0.5;
    h += hill * hill * (70 + 190 * smoothstep(0.3, 0.85, natural)) * inland;
    const ranges = smoothstep(-0.25, 0.45, fbm2(n.range, x / 4200, z / 4200, 2));
    const ridge = ridged2(n.ridge, wx / 2800, wz / 2800, fine - 1, 2.0, 0.45);
    const bulk = fbm2(n.range, wx / 1300 + 7.1, wz / 1300 - 3.4, fine - 1) * 0.5 + 0.5;
    const peaks = Math.pow(ridge, 1.3) * 0.55 + bulk * bulk * 0.45;
    // Ranges come from the natural continent, not the in-view anchor, and stay inland of the bay.
    const r = Math.hypot(x, z);
    const far = smoothstep(1200, 2800, r);
    const scale = 800 + 900 * smoothstep(1800, 4800, r);
    h += peaks * scale * smoothstep(0.04, 0.55, natural) * (0.12 + 0.88 * ranges) * far;
    // Spurs and gullies down every slope with real relief, finer as `lod` falls: far tiles' shading maps sample
    // more of them than their own vertices can hold.
    const relief = smoothstep(30, 400, h);
    if (relief > 0) h += (ridged2(n.erode, wx / 640, wz / 640, Math.max(1, 6 - lod), 2.1, 0.5) - 0.4) * relief * Math.min(h, 900) * 0.3;
    // Cliff faces (land only, so the coast mask and the sea are untouched): gullies and buttresses
    // break the top edge.
    const face = steep * smoothstep(0.0, 0.03, m) * (1 - smoothstep(0.12, 0.2, m));
    if (face > 0) h *= 1 - face * 0.35 * ridged2(n.gully, wx / 90, wz / 90, 2);
    return h;
  }

  function heightAt(x: number, z: number, lod = 0): number {
    return surfaceAt(x, z, lod, scratch);
  }

  function shoalAt(x: number, z: number): number {
    const r = Math.hypot(x, z);
    // Sand banks dot the bay out to the coast, leaving the water right under the camera deep.
    // Long, soft ramps so the banks shoal gradually instead of stepping up at one range.
    const reach = smoothstep(20, 170, r) * (1 - smoothstep(900, 1300, r));
    const patches = smoothstep(0.0, 0.4, fbm2(n.shoal, x / 160, z / 160, 3)) * reach;
    // One sand bank always lies in the opening view, close enough to see from steeply above.
    const bx = x - bank.x;
    const bz = z - bank.z;
    const lobe = fbm2(n.shoal, x / 60 + 3.3, z / 60 - 1.7, 2) * 0.35;
    const main = smoothstep(0.15, 0.6, Math.exp(-(bx * bx + bz * bz) / (bank.r * bank.r)) + lobe) * (1 - smoothstep(1400, 1700, r));
    return Math.max(patches, main);
  }

  const gridSize = options.gridSize ?? 320;
  const gridExtent = options.gridExtent ?? 1600;
  let grid: LandGrid | null = null;
  // Same lattice as the start grid, so both agree wherever they overlap.
  const nav = createNavField(maskAt, {
    min: -gridExtent,
    cell: (gridExtent * 2) / (gridSize - 1),
    // The route plan reads 3.4 km around the whale, the next shelf bake 2.3 km around the origin.
    maxTiles: 256,
    // Reuse the start grid's samples once it exists.
    known: (i, j) => (grid && i >= 0 && j >= 0 && i < gridSize && j < gridSize ? grid.mask[j * gridSize + i] : undefined),
  });

  // Metres to the nearest land of any kind, islets and rocks included, out to where island flanks reach the plain.
  const depthField = createDepthField(maskAt);

  /**
   * Ocean depth: the island profile by the true distance to the nearest land, and the wider continental shelf by the
   * planet's continental distance. The coast detail can add land up to COAST_DETAIL_REACH beyond the planet's own
   * coastline and the warp moves points up to WARP_REACH/2, so that distance is shortened by both and only ever
   * errs shallow.
   */
  function depthAt(x: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    warp(x, z);
    const continent = Math.max(0, planet.openAt(wx - ox, wz - oz) - COAST_DETAIL_REACH - WARP_REACH);
    return seabedDepth(continent, depthField.coastDistanceAt(x, z));
  }

  return {
    seed,
    regions,
    planet,
    landmarks,
    anchor,
    maskAt,
    heightAt,
    depthAt,
    prefetchDepth: depthField.prefetch,
    surfaceAt,
    shoalAt,
    get grid() {
      return (grid ??= buildGrid(maskAt, gridSize, gridExtent));
    },
    nav,
    offset: { x: ox, z: oz },
    viewYaw: options.viewYaw,
    clearance: nav.clearance,
    // About 500 m of sea for each unit of mask below the coast: rough, but needs no tile, so a plan can look 12 km out.
    // Near the start the exit from the bay is a channel narrower than a coarse cell: the most open of five samples across the cell lets a plan through it.
    reach: (x, z) =>
      -(x * x + z * z < 8000 * 8000
        ? Math.min(maskAt(x, z), maskAt(x + 220, z), maskAt(x - 220, z), maskAt(x, z + 220), maskAt(x, z - 220))
        : maskAt(x, z)) * 500,
    away: nav.away,
  };
}

function buildGrid(maskAt: (x: number, z: number) => number, size: number, extent: number): LandGrid {
  const cell = (extent * 2) / (size - 1);
  const min = -extent;
  const mask = new Float32Array(size * size);
  const inf = 1e20;
  const toLand = new Float64Array(size * size);
  const toSea = new Float64Array(size * size);
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const m = Math.fround(maskAt(min + ix * cell, min + iz * cell));
      mask[iz * size + ix] = m;
      toLand[iz * size + ix] = m > 0 ? 0 : inf;
      toSea[iz * size + ix] = m > 0 ? inf : 0;
    }
  }
  squaredDistance(toLand, size);
  squaredDistance(toSea, size);
  // Signed: positive at sea (metres to land), negative on land (metres to sea).
  const distance = new Float32Array(size * size);
  for (let i = 0; i < distance.length; i++) {
    distance[i] = (toLand[i] ?? 0) > 0 ? Math.sqrt(toLand[i] ?? 0) * cell : -Math.sqrt(toSea[i] ?? 0) * cell;
  }
  return { min, cell, size, mask, distance };
}

/** Fraction of land over a square window, sampled on a coarse lattice. */
export function landFraction(land: Land, extent = 4000, steps = 64): number {
  let count = 0;
  for (let iz = 0; iz < steps; iz++) {
    for (let ix = 0; ix < steps; ix++) {
      const x = -extent + ((ix + 0.5) / steps) * extent * 2;
      const z = -extent + ((iz + 0.5) / steps) * extent * 2;
      if (land.maskAt(x, z) > 0) count++;
    }
  }
  return count / (steps * steps);
}

/** Shallowness per texel for the water shader: 1 at the shore, 0 at ≥ 40 m depth. */
export interface ShelfMap {
  data: Uint8Array;
  size: number;
  /** World X (and Z unless `minZ` is set) of texel (0, 0) centre. */
  min: number;
  minZ?: number;
  extent: number;
}

/** Water depth (metres) by distance from the coast: a wide sandy shelf, then the drop-off. */
export function depthForDistance(metres: number): number {
  if (metres <= 0) return 0;
  if (metres < SHELF_WIDTH) return 1.5 + 6.5 * (metres / SHELF_WIDTH);
  return Math.min(200, 8 + (metres - SHELF_WIDTH) * 0.08 + Math.max(0, metres - 450) * 0.25);
}

/** Shallow, turquoise shelf width off every coast. */
export const SHELF_WIDTH = 150;

/** Shallowness of a texel at this distance from the coast: 255 at the shore, 0 at 40 m of water or more. */
function shelfTexel(distance: number): number {
  return Math.round(clamp(1 - depthForDistance(distance) / 40, 0, 1) * 255);
}

/** Clamp-to-edge sampling should read as open sea outside the map. */
function openEdges(data: Uint8Array, size: number): void {
  for (let i = 0; i < size; i++) {
    data[i] = 0;
    data[(size - 1) * size + i] = 0;
    data[i * size] = 0;
    data[i * size + size - 1] = 0;
  }
}

function shelfFromDistance(distance: ArrayLike<number>, size: number, min: number, extent: number): ShelfMap {
  const data = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = shelfTexel(distance[i] ?? 0);
  openEdges(data, size);
  return { data, size, min, extent };
}

export function nearShelf(land: Land): ShelfMap {
  const g = land.grid;
  const shelf = shelfFromDistance(g.distance, g.size, g.min, g.cell * (g.size - 1));
  addSandBanks(land, shelf, g.min, g.min, g.cell);
  return shelf;
}

export function farShelf(land: Pick<Land, 'maskAt'>, size = 384, extent = 6400, cx = 0, cz = 0): ShelfMap {
  const steps = farShelfSteps(land, size, extent, cx, cz);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** farShelf in slices of a few rows. */
export function* farShelfSteps(land: Pick<Land, 'maskAt'>, size = 384, extent = 6400, cx = 0, cz = 0): Generator<void, ShelfMap> {
  // Too coarse for an exact distance field: estimate it from the coast mask slope.
  const distance = new Float32Array(size * size);
  const cell = (extent * 2) / (size - 1);
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const m = land.maskAt(cx - extent + ix * cell, cz - extent + iz * cell);
      distance[iz * size + ix] = m > 0 ? 0 : -m / 0.0025;
    }
    if (iz % 6 === 5) yield;
  }
  return { ...shelfFromDistance(distance, size, cx - extent, extent * 2), minZ: cz - extent };
}

/**
 * Exact shelf map around world (cx, cz) from the navigation field, snapped to its
 * lattice; the start's sand banks are added where they reach.
 */
export function navShelf(land: Land, cx: number, cz: number, size = 320): ShelfMap {
  const steps = navShelfSteps(land, cx, cz, size);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** navShelf in slices: yields every few rows so a bake never holds up a frame. */
export function* navShelfSteps(land: Land, cx: number, cz: number, size = 320): Generator<void, ShelfMap> {
  const nav = land.nav;
  const i0 = Math.round((cx - nav.min) / nav.cell) - (size >> 1);
  const j0 = Math.round((cz - nav.min) / nav.cell) - (size >> 1);
  const data = new Uint8Array(size * size);
  // The clamped far field is open sea.
  const open = nav.saturation - 1e-3;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const distance = nav.distanceAt(nav.min + (i0 + i) * nav.cell, nav.min + (j0 + j) * nav.cell);
      data[j * size + i] = shelfTexel(distance >= open ? 1e4 : distance);
    }
    if (j % 8 === 7) yield;
  }
  openEdges(data, size);
  const minX = nav.min + i0 * nav.cell;
  const minZ = nav.min + j0 * nav.cell;
  const shelf: ShelfMap = { data, size, min: minX, extent: nav.cell * (size - 1), minZ };
  addSandBanks(land, shelf, minX, minZ, nav.cell);
  return shelf;
}

/** Sand banks: patches of 2–4 m water out in the start bay. */
function addSandBanks(land: Land, shelf: ShelfMap, minX: number, minZ: number, cell: number): void {
  const size = shelf.size;
  // Banks only lie within ~1.7 km of the start.
  const far = Math.hypot(Math.max(0, Math.abs(minX + (size * cell) / 2) - (size * cell) / 2), Math.max(0, Math.abs(minZ + (size * cell) / 2) - (size * cell) / 2));
  if (far > 1700) return;
  const bank = Math.round(clamp(1 - 2 / 40, 0, 1) * 255);
  for (let iz = 1; iz < size - 1; iz++) {
    for (let ix = 1; ix < size - 1; ix++) {
      const x = minX + ix * cell;
      const z = minZ + iz * cell;
      if (x * x + z * z > 1700 * 1700) continue;
      const i = iz * size + ix;
      const t = land.shoalAt(x, z);
      if (t > 0) shelf.data[i] = Math.max(shelf.data[i] ?? 0, Math.round((shelf.data[i] ?? 0) + (bank - (shelf.data[i] ?? 0)) * t));
    }
  }
}
