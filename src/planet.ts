import { createCurrent } from './current.js';
import { fbm2, makeNoise2D } from './noise.js';
import { hash } from './rng.js';
import { clamp, smoothstep } from './math.js';

/**
 * The world's layout at planet scale, a pure function of the seed and the migration heading: big continents and
 * large islands with long coastlines, wide open oceans and archipelagos now and then. The migration follows the
 * ocean current through a lane of open sea; the continents either side of the lane come near now and then and
 * stand far off (or are not there at all) most of the time. Land is a mask in the land mask's units: below
 * MACRO_OPEN nothing the coast detail adds reaches the surface.
 */
export interface Planet {
  /** Heading of the migration (whale convention: forward is (−cos h, sin h)); the current's steady flow runs along it. */
  heading: number;
  /** Macro land mask: > 0 land, < 0 sea, clamped to [MACRO_FLOOR, MACRO_CEIL]; the coast detail goes on top. */
  macroAt: (x: number, z: number) => number;
  /** Rough metres to the nearest continental coast (0 or less on land). */
  openAt: (x: number, z: number) => number;
  /** Lane coordinates: metres along the steady flow and across it from the lane's centreline (the current's path from the start). */
  laneAt: (x: number, z: number, out?: { s: number; q: number }) => { s: number; q: number };
  /** World point of the lane's centreline `s` metres along the steady flow. */
  laneCentre: (s: number) => { x: number; z: number };
  /** Distance from the equator in [0, 1] (1 at a pole); the start lies at 0.5. */
  latitudeAt: (x: number, z: number) => number;
}

/** Macro mask clamps: the open ocean sits at the floor, continent interiors at the ceiling. */
export const MACRO_FLOOR = -1.6;
export const MACRO_CEIL = 1;
/** Below this the coast detail can no longer raise land (it reaches about 0.9). */
export const MACRO_OPEN = -1.1;
/** Mask units per metre across a macro coast (the old coasts' slope, so shelves and depths read the same). */
export const COAST_SLOPE = 0.001;

/** Lane centreline: one point per LANE_STEP metres along the steady flow, integrated in chunks of LANE_CHUNK. */
const LANE_STEP = 500;
const LANE_CHUNK = 256;
/** Half-width (m) of the lane kept open whatever the continents do: a strait at its narrowest. */
const LANE_HALF = 6000;

/** Continents: warped fractal noise of this wavelength (m), land above LAND_LEVEL (about a third of the planet, as on Earth). */
const CONTINENT_WAVE = 260000;
const CONTINENT_WARP = 70000;
const LAND_LEVEL = 0.12;
/** Mask units per unit of continent noise: about COAST_SLOPE per metre across its coasts. */
const CONTINENT_GAIN = 67;
/** Metres the lane's strait through a continent widens per unit of continent noise above the level. */
const STRAIT_WIDEN = 50000;
/**
 * The continents are slid (one of PLACE_TRIES seeded offsets) so that over the first PLACE_REACH metres of the lane,
 * and over the first PLACE_FIRST (about the first hour), a continent's coast comes within PLACE_NEAR of it for about
 * PLACE_SHARE of the way, in runs of at most PLACE_RUN.
 */
const PLACE_TRIES = 64;
const PLACE_REACH = 500000;
const PLACE_FIRST = 80000;
const PLACE_STEP = 2000;
const PLACE_NEAR = 6000;
const PLACE_SHARE = 0.15;
const PLACE_RUN = 25000;

/**
 * Along the lane, one stretch of FEATURE_CELL metres in FEATURE_ODDS has a feature: a large island to one side
 * (its near shore at least ISLAND_GAP from the centreline) or, one time in CLUSTER_SHARE, a cluster of islets
 * the lane runs through. They bring land into view now and then on the long open crossings.
 */
const FEATURE_CELL = 32000;
const FEATURE_ODDS = 0.8;
const CLUSTER_SHARE = 0.3;
const ISLAND_GAP = 2500;
/** The first feature lies this far (m) along the lane: open sea first, after the opening's coast. */
const FEATURE_FROM = 25000;
/** Islet clusters, along the lane and in archipelago zones of ARCHIPELAGO_WAVE out in the oceans (none within ZONE_CLEAR of the lane). */
const ARCHIPELAGO_WAVE = 60000;
const ARCHIPELAGO_EDGE = [0.5, 0.6] as const;
const ZONE_CLEAR = 10000;
const ISLET_WAVE = 3500;
const ISLET_FROM = 0.25;
const ISLET_GAIN = 10;

/** Climate bands: equator to pole over LATITUDE_SPAN metres of the planet's north axis. */
export const LATITUDE_SPAN = 120000;
/** The placement scores the lane from here (m): the opening's own coast lies nearer. */
const START_COAST = 5000;
/** No islands within this distance of the start, where the opening is composed. */
const START_CLEAR = 9000;

export function createPlanet(seed: number, heading: number): Planet {
  const current = createCurrent(seed, heading);
  const s0 = hash(seed, 'planet');
  const continent = makeNoise2D(s0, 2);
  const shape = makeNoise2D(s0, 1);
  const warpX = makeNoise2D(s0, 3);
  const warpZ = makeNoise2D(s0, 4);
  const archipelagos = makeNoise2D(s0, 5);
  const islet = makeNoise2D(s0, 6);
  // Steady flow F and the across axis N (F turned a quarter left).
  const fx = -Math.cos(heading);
  const fz = Math.sin(heading);
  const nx = -fz;
  const nz = fx;
  // The planet's north axis crosses the lane at 35 to 55 degrees, so the migration crosses the climate bands.
  const tilt = ((hash(seed, 'planet-north') & 1 ? 1 : -1) * (35 + (hash(seed, 'planet-tilt') / 0x100000000) * 20) * Math.PI) / 180;
  const northX = fx * Math.cos(tilt) - fz * Math.sin(tilt);
  const northZ = fx * Math.sin(tilt) + fz * Math.cos(tilt);

  /** Lateral offset of the centreline at each LANE_STEP, by chunk; chunk 0 starts at the origin and runs forward. */
  const chunks = new Map<number, Float64Array>();
  const heading2 = (s: number, c: number): number => {
    // Slope dc/ds of the flow through (s, c): the current bends at most 30 degrees off its steady heading.
    const h = current(s * fx + c * nx, s * fz + c * nz);
    const vx = -Math.cos(h);
    const vz = Math.sin(h);
    return (vx * nx + vz * nz) / Math.max(0.5, vx * fx + vz * fz);
  };
  /** Integrates chunk k (midpoint rule) from the end of its neighbour nearer the origin, or from 0 at the origin. */
  function integrate(k: number): Float64Array {
    const dir = k >= 0 ? 1 : -1;
    const prev = k === 0 || k === -1 ? null : chunks.get(k - dir);
    if (prev === undefined) throw new Error(`lane chunk ${String(k - dir)} is integrated after ${String(k)}`);
    const out = new Float64Array(LANE_CHUNK + 1);
    let c = prev ? prev[dir > 0 ? LANE_CHUNK : 0] ?? 0 : 0;
    const start = k >= 0 ? k * LANE_CHUNK : (k + 1) * LANE_CHUNK;
    for (let i = 0; i <= LANE_CHUNK; i++) {
      const at = dir > 0 ? i : LANE_CHUNK - i;
      out[at] = c;
      const s = (start + dir * i) * LANE_STEP;
      const ds = dir * LANE_STEP;
      const mid = c + heading2(s, c) * ds * 0.5;
      c += heading2(s + ds * 0.5, mid) * ds;
    }
    chunks.set(k, out);
    return out;
  }
  function chunk(k: number): Float64Array {
    const out = chunks.get(k);
    if (out) return out;
    // Out from the origin, forward for k ≥ 0 and backward below: build the missing chunks in order, in a loop so a
    // far chunk cannot overflow the stack.
    const dir = k >= 0 ? 1 : -1;
    let from = k;
    while (from !== (dir > 0 ? 0 : -1) && !chunks.has(from - dir)) from -= dir;
    for (let j = from; j !== k; j += dir) integrate(j);
    return integrate(k);
  }
  function centre(s: number): number {
    if (!Number.isFinite(s)) return NaN;
    const f = s / LANE_STEP;
    const k = Math.floor(f / LANE_CHUNK);
    const data = chunk(k);
    const local = f - k * LANE_CHUNK;
    const i = Math.min(LANE_CHUNK - 1, Math.floor(local));
    const t = local - i;
    return (data[i] ?? 0) + ((data[i + 1] ?? 0) - (data[i] ?? 0)) * t;
  }

  const lane = { s: 0, q: 0 };
  function laneAt(x: number, z: number, out = { s: 0, q: 0 }): { s: number; q: number } {
    out.s = x * fx + z * fz;
    out.q = x * nx + z * nz - centre(out.s);
    return out;
  }

  let px = 0;
  let pz = 0;
  /** The continent noise (land above `levelAt`) at a world point, warped and slid by the placement. */
  function continentAt(x: number, z: number): number {
    const ux = x + px;
    const uz = z + pz;
    const wx = ux + fbm2(warpX, ux / (CONTINENT_WAVE * 1.3), uz / (CONTINENT_WAVE * 1.3), 2) * CONTINENT_WARP;
    const wz = uz + fbm2(warpZ, ux / (CONTINENT_WAVE * 1.3), uz / (CONTINENT_WAVE * 1.3), 2) * CONTINENT_WARP;
    return fbm2(continent, wx / CONTINENT_WAVE, wz / CONTINENT_WAVE, 5);
  }

  // Placement: the offset whose continents line the start of the lane closest to the wanted share and runs.
  {
    let best = { x: 0, z: 0, score: Infinity };
    for (let k = 0; k < PLACE_TRIES; k++) {
      px = (hash(s0, 'place-x', k) / 0x100000000 - 0.5) * 2e6;
      pz = (hash(s0, 'place-z', k) / 0x100000000 - 0.5) * 2e6;
      let near = 0;
      let first = 0;
      let run = 0;
      let longest = 0;
      for (let s = START_COAST; s < PLACE_REACH; s += PLACE_STEP) {
        const c = centre(s);
        const hit = [-PLACE_NEAR, PLACE_NEAR].some((q) => continentAt(s * fx + (c + q) * nx, s * fz + (c + q) * nz) > LAND_LEVEL);
        near += hit ? 1 : 0;
        if (hit && s < PLACE_FIRST) first++;
        run = hit ? run + PLACE_STEP : 0;
        longest = Math.max(longest, run);
      }
      const share = (near * PLACE_STEP) / (PLACE_REACH - START_COAST);
      const early = (first * PLACE_STEP) / (PLACE_FIRST - START_COAST);
      const score = Math.abs(share - PLACE_SHARE) + Math.abs(early - PLACE_SHARE) + Math.max(0, longest - PLACE_RUN) / 100000;
      if (score < best.score) best = { x: px, z: pz, score };
    }
    px = best.x;
    pz = best.z;
  }

  /** Unclamped macro mask from the lane and the continents; `whole` false stops early near the centreline, where the clamp hides the rest. */
  function macro(x: number, z: number, whole: boolean): number {
    laneAt(x, z, lane);
    const across = Math.abs(lane.q);
    if (!whole && (across - LANE_HALF) * COAST_SLOPE < MACRO_FLOOR * 2) return MACRO_FLOOR * 2;
    const above = continentAt(x, z) - LAND_LEVEL;
    // Where the lane crosses a continent the strait it keeps open widens with the land's bulk, into a sound.
    const byLane = (across - LANE_HALF - STRAIT_WIDEN * Math.max(0, above)) * COAST_SLOPE;
    const byContinent = above * CONTINENT_GAIN;
    return Math.min(byLane, byContinent);
  }

  type Feature = { s: number; q: number; radius: number; cluster: boolean } | null;
  const features = new Map<number, Feature>();
  function feature(k: number): Feature {
    let f = features.get(k);
    if (f !== undefined) return f;
    const u = (i: number) => hash(s0, 'feature', k, i) / 0x100000000;
    const s = (k + 0.15 + 0.7 * u(3)) * FEATURE_CELL;
    const side = u(2) < 0.5 ? 1 : -1;
    if (u(0) > FEATURE_ODDS || Math.abs(s) < FEATURE_FROM) f = null;
    else if (u(1) < CLUSTER_SHARE) f = { s, q: side * 3000 * u(5), radius: 2500 + 2000 * u(4), cluster: true };
    else {
      const radius = 1500 + 7000 * u(4) ** 2;
      f = { s, q: side * (ISLAND_GAP + radius * 1.3 + 2000 * u(5)), radius, cluster: false };
    }
    if (features.size > 4096) features.clear();
    features.set(k, f);
    return f;
  }

  /** Islet lift in [0, …): above about 1.6 an islet breaks the surface of the open sea. */
  const islets = (x: number, z: number, weight: number): number => weight * Math.max(0, fbm2(islet, x / ISLET_WAVE, z / ISLET_WAVE, 3) - ISLET_FROM) * ISLET_GAIN;

  /** The lane's islands and islet clusters, and the oceans' archipelagos, as a mask (MACRO_FLOOR where there are none). */
  function islands(x: number, z: number): number {
    if (Math.hypot(x, z) < START_CLEAR) return MACRO_FLOOR;
    laneAt(x, z, lane);
    let m = MACRO_FLOOR;
    const k0 = Math.floor(lane.s / FEATURE_CELL);
    for (let k = k0 - 1; k <= k0 + 1; k++) {
      const f = feature(k);
      if (!f) continue;
      const d = Math.hypot(lane.s - f.s, lane.q - f.q);
      if (d > f.radius * 1.4) continue;
      // A ragged outline, not a circle.
      const edge = f.radius * (1 + 0.3 * fbm2(shape, x / f.radius + k * 7.3, z / f.radius, 2));
      if (f.cluster) m = Math.max(m, MACRO_FLOOR + islets(x, z, 1 - smoothstep(edge * 0.4, edge, d)));
      else m = Math.max(m, (edge - d) * COAST_SLOPE);
    }
    // The oceans' archipelagos keep off the lane, which has its own clusters.
    const zone = smoothstep(ARCHIPELAGO_EDGE[0], ARCHIPELAGO_EDGE[1], fbm2(archipelagos, x / ARCHIPELAGO_WAVE, z / ARCHIPELAGO_WAVE, 2)) * smoothstep(ZONE_CLEAR, ZONE_CLEAR * 2, Math.abs(lane.q));
    return zone > 0 ? Math.max(m, MACRO_FLOOR + islets(x, z, zone)) : m;
  }

  return {
    heading,
    macroAt(x, z) {
      // A point that is not a number is open sea, so it cannot reach the terrain as a NaN height.
      if (!Number.isFinite(x) || !Number.isFinite(z)) return MACRO_FLOOR;
      const m = clamp(macro(x, z, false), MACRO_FLOOR, MACRO_CEIL);
      return m >= 0 ? m : Math.min(MACRO_CEIL, Math.max(m, islands(x, z)));
    },
    openAt(x, z) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return Infinity;
      return -macro(x, z, true) / COAST_SLOPE;
    },
    laneAt,
    laneCentre(s) {
      const c = centre(s);
      return { x: s * fx + c * nx, z: s * fz + c * nz };
    },
    latitudeAt(x, z) {
      const u = (x * northX + z * northZ) / LATITUDE_SPAN + 0.5;
      return 1 - Math.abs((((u % 2) + 2) % 2) - 1);
    },
  };
}
