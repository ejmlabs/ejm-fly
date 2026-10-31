import type { NoiseFunction2D } from 'simplex-noise';
import { fork } from './rng.js';
import { makeNoise2D } from './noise.js';
import { clamp } from './math.js';
import { clampClearOfLand, type Shore } from './shore.js';
import { createCurrent } from './current.js';
import { item } from './item.js';
import { trimOldest } from './bounded.js';

/** Hard cap on |Δheading| / dt. Gentle enough that a turn reads as a curve, not a spin. */
export const WHALE_MAX_TURN_RATE = 0.2;

/** Hard clearance from land passed to clampClearOfLand. */
export const WHALE_ISLAND_MARGIN = 20;

export interface WhaleCourse {
  x: number;
  z: number;
  heading: number;
  /** Heading the whale is steering for after looking ahead for land. */
  leg: number;
  /** Detour from the journey heading chosen at the last look-ahead (radians). */
  detour?: number;
  /** Journey bias: the journey slowly adopts the way the plans actually lead. */
  bias?: number;
  /** Look-ahead slot (time / LOOK_EVERY) of the last decision. */
  slot?: number;
  /** Plan slot (time / PLAN_EVERY) of the last plan, and the bearing it chose. */
  scan?: number;
  plan?: number | undefined;
  /** Open water the plans are heading for, held until reached, cut off or stale. */
  target?: { x: number; z: number; since: number; closest: number; closestAt: number } | undefined;
  planCache?: PlanCache;
  /** Targets that were reached, timed out or stalled on: open water around them is not planned for again for a while. */
  spent?: { x: number; z: number; at: number }[];
  /** Positions every PLAN_EVERY seconds (x, z pairs, oldest first): the headway the whale is making. */
  track?: number[];
  /** Where the whale was every 30 s for the last twenty minutes (x, z pairs, oldest first): water it has already tried. */
  trail?: number[];
  /** A heading the whale has committed to after making poor headway, and until when; no new one before `cooldown`. */
  escape?: { heading: number; until: number; cooldown: number; refresh: number; x: number; z: number };
  farCache?: PlanCache;
  startCache?: PlanCache;
  /** The way the wide plan leads, and when it is planned again. */
  far?: number | undefined;
  /** `far` eased, so the wide plan's choices do not flip the journey back and forth. */
  farSmooth?: number | undefined;
  farAt?: number;
  /** Forward speed, m/s; defaults to params.speed. */
  speed?: number;
  /** Steer for this point instead of the journey (feeding); land avoidance still applies. */
  aim?: { x: number; z: number } | null;
}

export interface WhaleCourseParams {
  baseHeading: number;
  /** Start point: only a fallback if the course ever turns non-finite. */
  homeX: number;
  homeZ: number;
  speed: number;
  turnRate: number;
  /** The journey heading at a point: the flow field's drift around baseHeading. */
  current: (x: number, z: number) => number;
  wanderFreq: number;
  wanderAmp: number;
  wanderPhase: number;
}

/** Shortest signed angle from `from` to `to`, in (−π, π]. */
export function shortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Horizontal direction the head points when `group.rotation.y = heading`
 * (lathe head sits on local −X; yaw-only YXZ).
 */
export function whaleForward(heading: number): { x: number; z: number } {
  return { x: -Math.cos(heading), z: Math.sin(heading) };
}

/** Heading whose forward matches the world XZ vector (dx, dz). */
export function headingToward(dx: number, dz: number): number {
  return Math.atan2(dz, -dx);
}

export function createWhaleCourseParams(
  seed: number,
  home: { x: number; z: number },
  heading: number,
): WhaleCourseParams {
  const rng = fork(seed, 'whale-course');
  return {
    baseHeading: heading,
    homeX: home.x,
    homeZ: home.z,
    speed: 1.55 + rng() * 0.45,
    turnRate: WHALE_MAX_TURN_RATE,
    current: createCurrent(seed, heading),
    wanderFreq: 0.013 + rng() * 0.01,
    wanderAmp: 0.25 + rng() * 0.15,
    wanderPhase: rng() * 64,
  };
}

export function createWhaleCourseNoise(seed: number): NoiseFunction2D {
  return makeNoise2D(seed, 11);
}

/** How far ahead of the hard margin the whale starts to bend away from land. */
const LAND_INFLUENCE = 34;

function avoidLand(
  x: number,
  z: number,
  heading: number,
  desired: number,
  shore: Shore,
  reach: number,
): number {
  const gap = shore.clearance(x, z);
  const influence = WHALE_ISLAND_MARGIN + LAND_INFLUENCE * reach;
  if (!(gap < influence)) return desired;
  const away = shore.away(x, z);
  // Direction toward the land is the reverse of the way out.
  const ndx = -away.x;
  const ndz = -away.z;
  const fwd = whaleForward(heading);
  const closeness = clamp(1 - (gap - WHALE_ISLAND_MARGIN * 0.5) / (influence - WHALE_ISLAND_MARGIN * 0.5), 0, 1);
  const ahead = fwd.x * ndx + fwd.z * ndz;
  if (ahead < 0.05 && closeness < 0.5) return desired;
  // Follow the coast on the nearer side; when very close, head straight out.
  const left = headingToward(-ndz, ndx);
  const right = headingToward(ndz, -ndx);
  const tangent = Math.abs(shortestAngle(desired, left)) <= Math.abs(shortestAngle(desired, right)) ? left : right;
  const flee = closeness > 0.72 ? headingToward(away.x, away.z) : tangent;
  const weight = clamp(closeness * (0.45 + 0.9 * clamp(ahead, 0, 1)), 0, 1);
  return desired + shortestAngle(desired, flee) * weight;
}

/** Seconds between look-aheads; fixed in sim time so 30 and 60 fps decide alike. */
export const LOOK_EVERY = 0.5;
/** Probe distances ahead and the clearance each wants. */
const PROBES: readonly (readonly [number, number])[] = [
  [60, WHALE_ISLAND_MARGIN + 30],
  [150, 50],
];
/** Detours tried, nearest the journey first; the last ones turn back out of a bay. */
const DETOURS = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.45, -1.45, 1.9, -1.9, 2.5, -2.5, Math.PI];

/** Seconds between plans of the way on (fixed in sim time). */
export const PLAN_EVERY = 5;
/**
 * The first plan waits this long: the opening needs none, and by then the
 * streamed navigation tiles it reads are built in the background.
 */
export const PLAN_START = 20;
/** Navigation tiles built around the start before the first frame: the look-ahead of the first steps reads no further, so the whale's first step builds none. */
export const OPENING_NAV_RADIUS = 1100;
/** Coarse planning disc: cell size and radius in cells (≈3.2 km, under two minutes at cruise). */
const PLAN_CELL = 160;
export const PLAN_RADIUS = 20;
/** Metres the planning disc reaches from the whale. */
export const PLAN_REACH = PLAN_RADIUS * PLAN_CELL;
/**
 * Coarse cells with this much clearance are deep water; down to PLAN_CLEAR (what
 * the look-ahead allows) they cost PLAN_SHALLOW_COST times as much to cross, so
 * routes keep off the coast (calmer, bluer water) unless a passage needs it.
 */
const PLAN_DEEP = 150;
const PLAN_CLEAR = 50;
const PLAN_SHALLOW_COST = 3;
/** Targets lie at least this many cells of path away; the plan steers for the path point PLAN_LEAD cells out. */
const PLAN_MIN_DEPTH = 12;
const PLAN_LEAD = 3;
/** The waypoint may lie up to this many cells down the path, if a straight line to it keeps this clear of land (sampled every LINE_STEP m). */
const PLAN_REACH_CELLS = 10;
const LINE_CLEAR = 60;
const LINE_STEP = 50;
/** A target is dropped once this close, or after this long. */
const TARGET_REACHED = 600;
const TARGET_SECONDS = 180;
/** No headway toward the target for this long means the way is shut. */
const STALL_SECONDS = 90;
/** Cells further behind the journey than this (cosine of the angle off it) lose BACKTRACK metres of score: a cone no-one turns back out of unless the way ahead is shut. */
const CONE = -0.17;
const BACKTRACK = 4000;

/** Water this close to a spent target (m) is not picked as a new one, and for this long (s): at the head of a gulf the whale then turns for its mouth instead of coming back to the same spot. */
const SPENT_RADIUS = 2200;
const SPENT_SECONDS = 1200;
const SPENT_MAX = 12;

/**
 * Forward progress. Over HEADWAY_SECONDS a whale that has swum far (more than HEADWAY_PATH metres) but made good
 * under HEADWAY_SHARE of it is circling or pacing a bay: it commits to the heading with the longest free run
 * for ESCAPE_SECONDS, then the journey bias carries that heading on while it relaxes.
 */
const HEADWAY_SECONDS = 90;
const HEADWAY_PATH = 1100;
const HEADWAY_SHARE = 0.25;
const ESCAPE_SECONDS = 600;
/** An escape ends once the whale is this far (m) from where it began, and its heading is planned again this often (s). */
const ESCAPE_DISTANCE = 6000;
const ESCAPE_REPLAN = 20;
/** The wide plan looks this often (s); where it leads more than this many radians off the flow, the journey follows it, so a gulf is not entered only to be left again. */
const FAR_EVERY = 20;
const FAR_TURN = 0.6;
/** The journey follows the wide plan at most this many radians a second. */
const FAR_RATE = 0.15;
const ESCAPE_COOLDOWN = 420;
/** Free run (m) tried along each of this many bearings, in steps; inside the navigation tiles kept built round the whale. */
const ESCAPE_BEARINGS = 24;
const ESCAPE_RUN = 3000;
const ESCAPE_STEP = 150;
const ESCAPE_CLEAR = 80;

/** The bearing with the longest stretch of open water ahead (up to ESCAPE_RUN), turned toward `prefer` among those that are as open. */
export function escapeHeading(x: number, z: number, prefer: number, shore: Shore, tried: readonly number[] = []): number {
  let best = prefer;
  let bestScore = -Infinity;
  for (let k = 0; k < ESCAPE_BEARINGS; k++) {
    const bearing = wrapAngle(prefer + (k / ESCAPE_BEARINGS) * Math.PI * 2);
    const fwd = whaleForward(bearing);
    let run = 0;
    while (run < ESCAPE_RUN && shore.clearance(x + fwd.x * (run + ESCAPE_STEP), z + fwd.z * (run + ESCAPE_STEP)) > ESCAPE_CLEAR) run += ESCAPE_STEP;
    // Open water all the way counts the same; then the bearing nearest the journey wins, never straight back.
    const turned = Math.abs(shortestAngle(prefer, bearing));
    // Water where the whale has already been (and come back from) is the last place to try.
    const end = whaleForward(bearing);
    let seen = 0;
    for (let i = 0; i < tried.length; i += 2) {
      if (Math.hypot(x + end.x * run - (tried[i] ?? 0), z + end.z * run - (tried[i + 1] ?? 0)) < 1500 || Math.hypot(x + end.x * run * 0.5 - (tried[i] ?? 0), z + end.z * run * 0.5 - (tried[i + 1] ?? 0)) < 1000) seen++;
    }
    const score = run + (run >= ESCAPE_RUN ? 400 * Math.cos(turned) : 0) - (turned > 2.4 ? 600 : 0) - 250 * Math.min(seen, 6);
    if (score > bestScore) {
      bestScore = score;
      best = bearing;
    }
  }
  return best;
}

/** The lattice a plan runs over: cell size (m), radius in cells, cells of path before a target counts, and the clearance it reads. */
export interface PlanGrid { cell: number; radius: number; minDepth: number; far: boolean }
const NEAR_GRID: PlanGrid = { cell: PLAN_CELL, radius: PLAN_RADIUS, minDepth: PLAN_MIN_DEPTH, far: false };
/** A wide, coarse plan (12.8 km) over `Shore.reach`: only used to find the way out when the near plan has gone nowhere. */
const EDGE_SHARE = 0.85;
const EDGE_BONUS = 30000;
const FAR_GRID: PlanGrid = { cell: 400, radius: 32, minDepth: 10, far: true };
/** Within this many metres of the start the exit is a channel, and the plan runs over coarser, more forgiving cells. */
const START_REACH = 8000;
const START_GRID: PlanGrid = { cell: 640, radius: 20, minDepth: 6, far: true };

/** The heading that leads out: along a wide coarse plan (12.8 km) where the shore can tell, else the longest free run. */
function widePlan(course: WhaleCourse, params: WhaleCourseParams, journey: number, shore: Shore) {
  const start = Math.hypot(course.x - params.homeX, course.z - params.homeZ) < START_REACH;
  const cache = start ? (course.startCache ??= new Map()) : (course.farCache ??= new Map());
  return planJourney(course.x, course.z, journey, shore, cache, undefined, [], start ? START_GRID : FAR_GRID);
}

function wayOut(course: WhaleCourse, params: WhaleCourseParams, flow: number, shore: Shore): number {
  const plan = widePlan(course, params, flow, shore);
  return plan ? plan.bearing : escapeHeading(course.x, course.z, flow, shore, course.trail);
}

/** Coarse clearance samples on a fixed world lattice, shared by successive plans. */
export type PlanCache = Map<string, number>;
const PLAN_CACHE_CAP = 40000;

/**
 * Bearing toward the open water furthest along `journey` that the whale can
 * actually reach: a cheapest-path search over a coarse grid of shore clearance
 * finds every reachable cell within ~1.6 km, where water near the coast costs
 * more than deep water, so routes keep off the shore unless a passage needs it.
 * The best cell is far along the journey and never behind it (outside the cone
 * of the journey heading) unless the way ahead is shut, and the whale steers
 * for a point a few cells down the path to it. A dead-end gulf is left by the
 * way it was entered, and a bay by its mouth, without pacing. A held target
 * (`keep`) wins while it can still be reached. Returns null when boxed in.
 */
export function planJourney(
  x: number,
  z: number,
  journey: number,
  shore: Shore,
  cache: PlanCache,
  keep?: { x: number; z: number },
  spent: readonly { x: number; z: number }[] = [],
  grid: PlanGrid = NEAR_GRID,
): { bearing: number; x: number; z: number; steps: number } | null {
  const side = grid.radius * 2 + 1;
  const ci = Math.floor(x / grid.cell);
  const cj = Math.floor(z / grid.cell);
  /** Cost of crossing a cell: 1 in deep water, more near the coast, Infinity where too close. */
  const cost = (li: number, lj: number): number => {
    // Only the disc is planned over: the square's corners lie beyond the navigation tiles kept built around the whale.
    if ((li - grid.radius) ** 2 + (lj - grid.radius) ** 2 > grid.radius * grid.radius) return Infinity;
    const i = ci + li - grid.radius;
    const j = cj + lj - grid.radius;
    const key = `${String(i)}:${String(j)}`;
    let m = cache.get(key);
    if (m === undefined) {
      m = grid.far ? (shore.reach ?? shore.clearance)((i + 0.5) * grid.cell, (j + 0.5) * grid.cell) : shore.clearance((i + 0.5) * grid.cell, (j + 0.5) * grid.cell);
      cache.set(key, m);
      trimOldest(cache, PLAN_CACHE_CAP);
    }
    return m > PLAN_DEEP ? 1 : m > PLAN_CLEAR ? PLAN_SHALLOW_COST : Infinity;
  };
  const n = side * side;
  const dist = new Float64Array(n).fill(Infinity);
  const steps = new Int16Array(n);
  const parent = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  // Binary heap of cell indices keyed by dist.
  const heap: number[] = [];
  const push = (k: number) => {
    heap.push(k);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if ((dist[heap[p] ?? 0] ?? 0) <= (dist[k] ?? 0)) break;
      heap[c] = heap[p] ?? 0;
      c = p;
    }
    heap[c] = k;
  };
  const pop = (): number => {
    const top = heap[0] ?? 0;
    const last = heap.pop() ?? 0;
    if (heap.length) {
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        if (l >= heap.length) break;
        const r = l + 1;
        const m = r < heap.length && (dist[heap[r] ?? 0] ?? 0) < (dist[heap[l] ?? 0] ?? 0) ? r : l;
        if ((dist[heap[m] ?? 0] ?? 0) >= (dist[last] ?? 0)) break;
        heap[c] = heap[m] ?? 0;
        c = m;
      }
      heap[c] = last;
    }
    return top;
  };
  const start = grid.radius * side + grid.radius;
  dist[start] = 0;
  push(start);
  const fwd = whaleForward(journey);
  const keepI = keep ? Math.floor(keep.x / grid.cell) - ci + grid.radius : -1;
  const keepJ = keep ? Math.floor(keep.z / grid.cell) - cj + grid.radius : -1;
  const keepK = keepI >= 0 && keepJ >= 0 && keepI < side && keepJ < side ? keepJ * side + keepI : -1;
  let best = -1;
  let bestScore = -Infinity;
  let any = -1;
  let anyScore = -Infinity;
  while (heap.length) {
    const k = pop();
    if (done[k]) continue;
    done[k] = 1;
    const li = k % side;
    const lj = (k - li) / side;
    if ((steps[k] ?? 0) >= grid.minDepth) {
      const wx = (ci + li - grid.radius + 0.5) * grid.cell;
      const wz = (cj + lj - grid.radius + 0.5) * grid.cell;
      const dx = wx - x;
      const dz = wz - z;
      // Far along the journey, never back across it, and not too winding or shallow a way there.
      const away = Math.hypot(dx, dz);
      const along = dx * fwd.x + dz * fwd.z;
      // Behind the cone only the furthest reachable cell counts: out of a pocket by its mouth, not along its far wall.
      // On the wide plan, water that runs on to the edge of the lattice beats any dead end short of it: a gulf is not entered.
      const open = grid.far && away >= grid.radius * grid.cell * EDGE_SHARE ? EDGE_BONUS : 0;
      const score = open + (along < CONE * away ? away - BACKTRACK : along) - 0.3 * ((dist[k] ?? 0) * grid.cell - away);
      // Water by a spent target is a way through, not somewhere to head for.
      if (score > bestScore && !spent.some((t) => Math.hypot(wx - t.x, wz - t.z) < SPENT_RADIUS)) {
        bestScore = score;
        best = k;
      }
      // Boxed in with every candidate spent: the best of them still beats no plan.
      if (score > anyScore) {
        anyScore = score;
        any = k;
      }
    }
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ni = li + di;
        const nj = lj + dj;
        if (ni < 0 || nj < 0 || ni >= side || nj >= side) continue;
        const nk = nj * side + ni;
        if (done[nk]) continue;
        const c = cost(ni, nj);
        if (c === Infinity) continue;
        // Diagonal moves may not squeeze between two closed cells.
        if (di !== 0 && dj !== 0 && cost(li + di, lj) === Infinity && cost(li, lj + dj) === Infinity) continue;
        const next = (dist[k] ?? 0) + c * (di !== 0 && dj !== 0 ? Math.SQRT2 : 1);
        if (next < (dist[nk] ?? 0)) {
          dist[nk] = next;
          steps[nk] = (steps[k] ?? 0) + 1;
          parent[nk] = k;
          push(nk);
        }
      }
    }
  }
  if (keepK >= 0 && done[keepK] && keepK !== start) best = keepK;
  if (best < 0) best = any;
  if (best < 0) return null;
  const bi = best % side;
  const bj = (best - bi) / side;
  const target = { x: (ci + bi - grid.radius + 0.5) * grid.cell, z: (cj + bj - grid.radius + 0.5) * grid.cell };
  // The path from the whale to the target, nearest cell first.
  const path: number[] = [];
  for (let k = best; k !== start && k >= 0; k = parent[k] ?? 0) path.push(k);
  path.reverse();
  let waypoint = path[Math.min(path.length, PLAN_LEAD) - 1] ?? best;
  if (!grid.far) {
    // Steer for the furthest point of the path in a straight, clear line, so a corner is not cut across the coast.
    for (let n = Math.min(path.length, PLAN_REACH_CELLS); n > PLAN_LEAD; n--) {
      const k = path[n - 1] ?? 0;
      const px = (ci + (k % side) - grid.radius + 0.5) * grid.cell;
      const pz = (cj + (k - (k % side)) / side - grid.radius + 0.5) * grid.cell;
      const run = Math.hypot(px - x, pz - z);
      let clear = true;
      for (let d = LINE_STEP; d < run && clear; d += LINE_STEP) clear = shore.clearance(x + ((px - x) * d) / run, z + ((pz - z) * d) / run) > LINE_CLEAR;
      if (clear) {
        waypoint = k;
        break;
      }
    }
  }
  const li = waypoint % side;
  const lj = (waypoint - li) / side;
  const wx = (ci + li - grid.radius + 0.5) * grid.cell;
  const wz = (cj + lj - grid.radius + 0.5) * grid.cell;
  return { bearing: headingToward(wx - x, wz - z), ...target, steps: steps[best] ?? 0 };
}

/** How open a bearing is from (x, z): 0 when every probe has its clearance, growing as land closes in. */
function blockage(x: number, z: number, bearing: number, shore: Shore, reach: number): number {
  const fwd = whaleForward(bearing);
  let cost = 0;
  for (const [d, want] of PROBES) {
    const gap = shore.clearance(x + fwd.x * d * reach, z + fwd.z * d * reach);
    // Near probes weigh most: land at 60 m matters more than land at 400 m.
    if (gap < want) cost += ((want - gap) / want) * (500 / d);
  }
  return cost;
}

/** Picks the detour from the journey heading that leads to the most open water. */
function chooseDetour(course: WhaleCourse, journey: number, shore: Shore, reach: number): number {
  const previous = course.detour ?? 0;
  if (blockage(course.x, course.z, journey, shore, reach) === 0) return 0;
  let best = previous;
  let bestCost = Infinity;
  for (const detour of DETOURS) {
    const bearing = journey + detour;
    const cost =
      blockage(course.x, course.z, bearing, shore, reach) * 4 +
      Math.abs(detour) * 0.35 +
      // Holding the last choice keeps the whale from dithering between two gaps.
      Math.abs(shortestAngle(journey + previous, bearing)) * 0.25 +
      // Turning hard costs too.
      Math.abs(shortestAngle(course.heading, bearing)) * 0.1;
    if (cost < bestCost) {
      bestCost = cost;
      best = detour;
    }
  }
  return best;
}

/**
 * Advance the journey one step. The whale follows a slowly swinging journey
 * heading, never a home. Every PLAN_EVERY seconds it plans a way on through
 * the water it can reach (see planJourney), and the journey slowly
 * adopts where the plans lead. Every LOOK_EVERY seconds it probes the water
 * ahead and to either side and picks the most open bearing near the plan.
 * Near-field avoidance and a hard clearance clamp stay as the last guard.
 */
export function stepWhaleCourse(
  course: WhaleCourse,
  dt: number,
  time: number,
  shore: Shore,
  params: WhaleCourseParams,
  noise: NoiseFunction2D,
): void {
  if (!(dt > 0) || !Number.isFinite(dt) || !Number.isFinite(time)) return;
  const speed = course.speed ?? params.speed;
  // A faster whale looks further ahead for land, so its wider curves still clear the coast.
  const reach = Math.max(1, speed / 3);

  const n1 = noise(time * params.wanderFreq + params.wanderPhase, 2.5);
  const n2 = noise(time * params.wanderFreq * 0.37 + 11.0, params.wanderPhase * 0.2 + 4.0);
  const wander = (n1 * 0.78 + n2 * 0.22) * params.wanderAmp;
  let bias = course.bias ?? 0;
  const scan = Math.floor(time / PLAN_EVERY);
  let escape = course.escape;
  const flow = params.current(course.x, course.z);
  const pick = (): number => {
    if (escape && time < escape.until) return escape.heading;
    const flowing = flow + bias;
    return course.farSmooth !== undefined && Math.abs(shortestAngle(flowing, course.farSmooth)) > FAR_TURN ? course.farSmooth : flowing;
  };
  let heading = pick();
  if (course.scan !== scan && time >= PLAN_START) {
    course.scan = scan;
    if (course.far !== undefined) {
      course.farSmooth = course.farSmooth === undefined ? course.far : wrapAngle(course.farSmooth + clamp(shortestAngle(course.farSmooth, course.far), -FAR_RATE * PLAN_EVERY, FAR_RATE * PLAN_EVERY));
    } else course.farSmooth = undefined;
    if (time >= (course.farAt ?? 0)) {
      course.farAt = time + FAR_EVERY;
      course.far = widePlan(course, params, flow + bias, shore)?.bearing;
      heading = pick();
    }
    // Headway over the last two minutes: a whale that swims far and goes nowhere commits to the way out.
    const track = (course.track ??= []);
    track.push(course.x, course.z);
    if (scan % 6 === 0) {
      const trail = (course.trail ??= []);
      trail.push(course.x, course.z);
      if (trail.length > 80) trail.splice(0, 2);
    }
    const need = HEADWAY_SECONDS / PLAN_EVERY + 1;
    if (track.length > need * 2) track.splice(0, track.length - need * 2);
    if (track.length === need * 2 && !course.aim && (!escape || time >= escape.cooldown)) {
      let path = 0;
      for (let i = 2; i < track.length; i += 2) path += Math.hypot((track[i] ?? 0) - (track[i - 2] ?? 0), (track[i + 1] ?? 0) - (track[i - 1] ?? 0));
      const net = Math.hypot((track[track.length - 2] ?? 0) - (track[0] ?? 0), (track[track.length - 1] ?? 0) - (track[1] ?? 0));
      if (path > HEADWAY_PATH && net < HEADWAY_SHARE * path) {
        const out = wayOut(course, params, flow, shore);
        escape = course.escape = { heading: out, until: time + ESCAPE_SECONDS, cooldown: time + ESCAPE_COOLDOWN, refresh: time + ESCAPE_REPLAN, x: course.x, z: course.z };
        // The flow resumes slowly: its bias carries the committed heading on.
        bias = course.bias = clamp(wrapAngle(out - flow), -0.7, 0.7);
        course.target = undefined;
        track.length = 0;
      }
    }
    if (escape && time < escape.until) {
      if (Math.hypot(course.x - escape.x, course.z - escape.z) > ESCAPE_DISTANCE) escape.until = time;
      else if (time >= escape.refresh) {
        escape.refresh = time + ESCAPE_REPLAN;
        escape.heading = wayOut(course, params, flow, shore);
      }
    }
    const held = course.target;
    const gap = held ? Math.hypot(held.x - course.x, held.z - course.z) : 0;
    // Headway is measured along the planned path (held.closest is in path cells).
    const stalled = !!held && time - held.closestAt > STALL_SECONDS;
    const keep = held && !stalled && time - held.since < TARGET_SECONDS && gap > TARGET_REACHED ? held : undefined;
    // A target let go (reached, stalled on or too old) is spent: no new target is picked by it for a while.
    const spent = (course.spent ??= []);
    if (held && !keep) spent.push({ x: held.x, z: held.z, at: time });
    while (spent.length > SPENT_MAX || (spent.length && time - item(spent, 0).at > SPENT_SECONDS)) spent.shift();
    const cache = (course.planCache ??= new Map());
    const plan2 = (k?: { x: number; z: number }) => planJourney(course.x, course.z, heading, shore, cache, k, spent);
    let plan = plan2(keep);
    if (course.plan !== undefined && (stalled || (keep && (plan?.x !== keep.x || plan.z !== keep.z)))) {
      // The way to the held target closed up ahead (or the whale made no headway): remember
      // that gap as shut, so it does not turn back and try it again a few minutes later.
      const fwd = whaleForward(course.plan);
      for (let d = PLAN_CELL; d <= PLAN_CELL * 3; d += PLAN_CELL) {
        cache.set(`${String(Math.floor((course.x + fwd.x * d) / PLAN_CELL))}:${String(Math.floor((course.z + fwd.z * d) / PLAN_CELL))}`, -Infinity);
      }
      plan = plan2();
    }
    course.plan = plan?.bearing;
    if (!plan) course.target = undefined;
    else if (plan.x !== keep?.x || plan.z !== keep.z) {
      course.target = { x: plan.x, z: plan.z, since: time, closest: plan.steps, closestAt: time };
    } else if (course.target && plan.steps < course.target.closest) {
      course.target.closest = plan.steps;
      course.target.closestAt = time;
    }
  }
  const journey = course.plan ?? heading;
  // Over ten minutes or so the journey itself turns the way the plans lead.
  // The bias also relaxes back to the flow's heading, so the way around a coast does not become the new course.
  course.bias = wrapAngle(bias + shortestAngle(heading, journey) * clamp(dt / 600, 0, 1) - bias * clamp(dt / 1200, 0, 1));

  const slot = Math.floor(time / LOOK_EVERY);
  if (course.slot !== slot) {
    course.slot = slot;
    course.detour = chooseDetour(course, journey, shore, reach);
  }
  const detour = course.detour ?? 0;
  // The meander only plays in open water.
  const aim = course.aim;
  let desired = aim ? headingToward(aim.x - course.x, aim.z - course.z) : journey + detour + (detour === 0 ? wander : 0);
  course.leg = wrapAngle(desired);
  desired = avoidLand(course.x, course.z, course.heading, desired, shore, reach);

  const delta = shortestAngle(course.heading, desired);
  const maxStep = params.turnRate * dt;
  course.heading = wrapAngle(course.heading + clamp(delta, -maxStep, maxStep));

  const fwd = whaleForward(course.heading);
  course.x += fwd.x * speed * dt;
  course.z += fwd.z * speed * dt;

  const cleared = clampClearOfLand(course.x, course.z, shore, WHALE_ISLAND_MARGIN + 0.05);
  course.x = cleared.x;
  course.z = cleared.z;

  if (!Number.isFinite(course.x) || !Number.isFinite(course.z) || !Number.isFinite(course.heading) || !Number.isFinite(course.leg)) {
    course.x = params.homeX;
    course.z = params.homeZ;
    course.heading = wrapAngle(params.baseHeading);
    course.leg = course.heading;
    course.detour = 0;
    course.bias = 0;
    course.plan = undefined;
    course.target = undefined;
  }
}

export interface WhalePilot {
  params: WhaleCourseParams;
  step: (course: WhaleCourse, dt: number, time: number, shore: Shore) => void;
}

export function createWhalePilot(
  seed: number,
  home: { x: number; z: number },
  heading: number,
): WhalePilot {
  const params = createWhaleCourseParams(seed, home, heading);
  const noise = createWhaleCourseNoise(seed);
  return {
    params,
    step(course, dt, time, shore) {
      stepWhaleCourse(course, dt, time, shore, params, noise);
    },
  };
}
