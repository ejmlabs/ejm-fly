import type { Shore } from './shore.js';
import { fork } from './rng.js';
import { makeNoise2D } from './noise.js';
import { clamp, damp, lerp, smoothstep } from './math.js';
import { DEPTH_SCALE } from './whale-size.js';
import { createSpring, springSet, springStep } from './spring.js';
import { FEED_CELL, feedSiteInCell, type FeedSite } from './feed-sites.js';
import { WHALE_ISLAND_MARGIN, WHALE_MAX_TURN_RATE, createWhalePilot, headingToward, shortestAngle, whaleForward, type WhaleCourse } from './whale-course.js';
import {
  DIVE_SINK,
  FLOOR_CLEARANCE,
  PHASE_LEN,
  POSE_KEYS,
  REST_ARCH,
  SHALLOW_Y,
  SWIM_PITCH,
  emptyPose,
  whalePose,
  type WhalePhase,
  type WhalePose,
} from './whale-motion.js';
import { trimOldest } from './bounded.js';

export type WhaleBehavior = 'travel' | 'feed' | 'breathe';

/** Travel speed range, m/s: noise moves between cruising, speeding up and easing off. */
export const TRAVEL_MIN = 16;
export const TRAVEL_MAX = 28;
/** A surfacing is a glide at this share of the cruising speed, never a stop. */
export const BREATH_PACE = 0.75;
/** Acceleration limits, m/s²: easing off is a little quicker than speeding up. */
export const MAX_ACCEL = 1.4;
export const MAX_DECEL = 2;
/**
 * Seconds from the fluke-up dive to the start of the climb back: seeded in this range (a feed may hold it to
 * FEED_HOLD). With the descent and the climb a whole dive takes about four to six minutes, a blue whale's eight to
 * fifteen at the journey's pace.
 */
export const DIVE_MIN = 120;
export const DIVE_MAX = 240;
/** Blows in one surfacing, about fifteen seconds apart: seeded in this range, each a rise, a spout and (between blows) a roll back under. */
export const BLOWS: readonly [number, number] = [2, 6];
/** Seconds per stretch of a surfacing: the rise into a blow and the glide just under between blows. */
const RISE_LEN: readonly [number, number] = [3.5, 5];
const ROLL_LEN: readonly [number, number] = [5, 9];
/** Depth of a feeding dive (m): slow noise between these, kept clear of the floor. Blue whales feed at 100 to 200 m. */
export const DIVE_DEPTH: readonly [number, number] = [-100, -200];
/** Now and then a dive runs deeper, toward this. */
export const DEEPEST_DIVE = -300;
/** Share of fluke-up dives that lift the flukes clear of the water; the rest slide under with the flukes low. */
export const FLUKE_UP_SHARE = 0.3;
/** Share of surfacings that end in a breach. */
export const BREACH_CHANCE = 0.04;
/** Fastest the whale sinks or climbs on a long dive, m/s: steady, as a blue whale descends at 1.5 to 3 m/s. */
export const VERTICAL_SPEED = 2;
/** Vertical speed near the end of a climb or a descent (m/s). */
const VERTICAL_EASE = 0.7;
/** Where the floor keeps the whale shallower than this, it stays up and breathes instead of diving. */
export const SHALLOWEST_DIVE = -5 * DEPTH_SCALE;
/** A fluke-up dive starts only with room to dive along this many seconds of path ahead. */
export const DIVE_ROOM = 45;
/** Vertical spring rate (1/s): the body follows the depth rail with eased starts and stops. */
const DEPTH_OMEGA = 0.55;
/** Spring rate (1/s) of the eased floor the body keeps clear of. */
const FLOOR_OMEGA = 1.5;
/** Gap kept over the floor by the rail: clear of the floor limit's soft band, so the floor never jolts the body. */
const RAIL_CLEARANCE = FLOOR_CLEARANCE + 2 * DEPTH_SCALE;
/** Seconds of path ahead the floor is read over closely, and sparsely out to where the deepest dive could still climb clear. */
const FLOOR_AHEAD = 30;
const FLOOR_FAR = -DEEPEST_DIVE / VERTICAL_SPEED + 10;
/** The far read: seconds between samples, every how many decisions, and the turn rates of its fan. */
const FLOOR_FAR_EVERY = 1;
const FLOOR_FAR_DECISIONS = 4;
const FLOOR_FAR_TURNS = [-0.1, -0.03, 0, 0.03, 0.1];
/** The floor is read along a fan of arcs either side of the course, since the pilot may turn into a rise: turn rates (rad/s), each held until the heading is that far off (rad). */
const FLOOR_TURNS = [-0.2, -0.15, -0.1, -0.05, -0.025, 0, 0.025, 0.05, 0.1, 0.15, 0.2];
const FLOOR_FAN = 0.7;
/** Feeding is rare: at least this many seconds from the end of one feed (or the start) to the next, and none longer than FEED_MAX. */
const FEED_GAP: readonly [number, number] = [480, 720];
const FEED_FIRST: readonly [number, number] = [150, 300];
const FEED_MAX = 25;
/** Speeds while feeding, m/s: slow enough to turn inside a small swarm (turn radius is speed / turn rate). */
const APPROACH_SLOW = 4;
/** Slowest approach while still lining up on a swarm (m/s). */
const APPROACH_CREEP = 1.2;
const LUNGE_SPEED = 3.4;
const CIRCLE_SPEED = 1.6;
/** A feed starts only this long before a due breath, and holds that breath until at least FEED_HOLD after it starts. */
const FEED_WINDOW = 60;
const FEED_HOLD = 100;
/** Feed sites are looked for this far around the whale, and only roughly ahead: a blue whale finds krill over kilometres. */
const FEED_RANGE = 1200;
/** An approach that has not reached its site by then gives up. */
const APPROACH_SECONDS = 100;
/** Seconds between decisions; fixed in sim time so 30 and 60 fps decide alike. */
const DECIDE_EVERY = 0.5;

/** A posed stretch (surface, spout, dive, breach, splash) played from whalePose. */
/** A posed stretch; `lift` scales a fluke-up dive's fluke lift. */
interface Segment { phase: WhalePhase; len: number; t: number; lift?: number }

export interface WhaleMotion {
  x: number;
  z: number;
  heading: number;
  /** Horizontal speed right now, m/s (breach surge included). */
  speed: number;
  behavior: WhaleBehavior;
  phase: WhalePhase;
  phaseT: number;
  /** Eased target pose; the caller adds the surface bob and the floor limit. */
  pose: WhalePose;
  /** Floor the body keeps clear of: the seafloor under and just ahead, eased so a bump or a reef edge never jolts it (undefined without floorAt). */
  floor: number | undefined;
  /** The bait ball or krill swarm being fed on or approached. */
  site: FeedSite | null;
  /** Smoothed turn rate, rad/s (positive turns left): the body bends into it. */
  turn: number;
}

export interface WhaleMover {
  motion: WhaleMotion;
  /** The pilot's course, for review and tools. */
  course: WhaleCourse;
  /** Factor on the travel speed (breaths included); feeding moves are unchanged. */
  pace: number;
  step: (dt: number, time: number, shore: Shore) => void;
  /** Play `phase` from normalised time `t` for review; the whale holds position (surge aside) and snaps to it. */
  force: (phase: WhalePhase, t: number) => void;
  /** Review only: put the whale at (x, z), keeping its heading. */
  place: (x: number, z: number) => void;
}

/**
 * Pure, seeded whale behaviour: a small state machine on top of the journey planner.
 * `travel` is the long dive at depth (a feed may interrupt it); `breathe` is the climb
 * back and a surfacing of a few blows that ends in a fluke-up dive. Speed and dive depth
 * follow slow noise; every change of pose eases through a decaying offset, so no
 * transition jumps in height, pitch or heading.
 */
export function createWhaleMover(
  seed: number,
  home: { x: number; z: number },
  heading: number,
  floorAt?: (x: number, z: number) => number,
  /** Heading of the long journey; the whale turns to it from `heading`. */
  journey = heading,
): WhaleMover {
  const rng = fork(seed, 'whale-behavior');
  const noise = makeNoise2D(seed, 23);
  const pilot = createWhalePilot(seed, home, journey);
  const course: WhaleCourse = { x: home.x, z: home.z, heading, leg: heading, speed: 1 };

  /** Travel speed: two octaves of slow noise, so surges and lulls never repeat. */
  const travelSpeed = (t: number) =>
    lerp(TRAVEL_MIN, TRAVEL_MAX, smoothstep(-0.65, 0.45, 0.7 * noise(t / 34, 0.5) + 0.3 * noise(t / 11, 3.7)));
  /** Depth of the long dive: slow noise, so one dive runs deeper than the next, and now and then much deeper. */
  const diveDepth = (t: number) =>
    lerp(lerp(DIVE_DEPTH[0], DIVE_DEPTH[1], smoothstep(-0.6, 0.6, noise(t / 40, 12.9))), DEEPEST_DIVE, smoothstep(0.45, 0.8, noise(t / 150, 31.7)));
  const jitter = (a: number, b: number) => a + (b - a) * rng();

  const queue: Segment[] = [];
  const posed = (phase: WhalePhase, len = PHASE_LEN[phase]): Segment =>
    phase === 'dive' ? { phase, len, t: 0, lift: rng() < FLUKE_UP_SHARE ? 1 : 0.3 } : { phase, len, t: 0 };
  /** One more blow: roll back under from the last one, glide, rise and spout. */
  const blowCount = () => BLOWS[0] + Math.floor(rng() * (BLOWS[1] - BLOWS[0] + 1));
  const blow = (): Segment[] => [posed('roll', jitter(ROLL_LEN[0], ROLL_LEN[1])), posed('surface', jitter(RISE_LEN[0], RISE_LEN[1])), posed('spout')];

  // The opening is a surfacing already under way: mid-rise, so the first blow comes within seconds.
  let behavior: WhaleBehavior = 'breathe';
  let seg: Segment | null = { phase: 'surface', len: PHASE_LEN.surface, t: PHASE_LEN.surface * 0.45 };
  queue.push(posed('spout'));
  const openingBlows = blowCount();
  for (let i = 1; i < openingBlows; i++) queue.push(...blow());
  queue.push(posed('dive'));
  let breathing = true;
  /** Held up for want of room to dive: the whale travels at the surface at full pace until it has room. */
  let held = false;
  let forced = false;
  let nextBreath = Infinity;
  let nextFeed = jitter(FEED_FIRST[0], FEED_FIRST[1]);
  let site: FeedSite | null = null;
  let siteSince = 0;
  let feedStart: number | null = null;
  let feedLen = 0;
  let lunge = false;
  let circleDir = 1;
  const visited = new Set<number>();
  const cells = new Map<string, FeedSite | null>();
  let slot = -1;

  let speed = 1;
  let speedGoal = 1;
  const depth = createSpring(SHALLOW_Y);
  /** Depth the spring follows: walks toward the goal at no more than VERTICAL_SPEED. */
  let rail = SHALLOW_Y;
  /** Floor limit on the rail from the path ahead, read with each decision. */
  let floorNeed = -Infinity;
  const floorEase = createSpring(floorAt?.(home.x, home.z));
  let label: WhalePhase = 'surface';
  /** The segment the pose came from last step (null while cruising). */
  let source: Segment | null = seg;
  let labelT = 0;
  let bank = 0;
  let turn = 0;

  const target = emptyPose();
  const offset = emptyPose();
  for (const key of POSE_KEYS) offset[key] = 0;
  /** Where the old pose source leaves off and the new one picks up, at a change of source. */
  const leave = emptyPose();
  const pick = emptyPose();
  const motion: WhaleMotion = {
    x: course.x,
    z: course.z,
    heading,
    speed,
    behavior,
    phase: 'surface',
    phaseT: 0.45,
    pose: whalePose('surface', 0.45),
    floor: floorAt && floorEase.x,
    site: null,
    turn: 0,
  };

  function siteIn(cx: number, cz: number): FeedSite | null {
    const key = `${String(cx)}:${String(cz)}`;
    let s = cells.get(key);
    if (s === undefined) {
      // Without a seabed there is nothing to feed over.
      if (!floorAt) return null;
      s = feedSiteInCell(seed, cx, cz, floorAt);
      cells.set(key, s);
      trimOldest(cells, 256);
    }
    return s;
  }

  /** Nearest unvisited site roughly ahead, in reach and clear of the coast. */
  function findSite(shore: Shore): FeedSite | null {
    const fwd = whaleForward(course.heading);
    let best: FeedSite | null = null;
    let bestD = FEED_RANGE;
    for (let cz = Math.floor((course.z - FEED_RANGE) / FEED_CELL); cz <= Math.floor((course.z + FEED_RANGE) / FEED_CELL); cz++) {
      for (let cx = Math.floor((course.x - FEED_RANGE) / FEED_CELL); cx <= Math.floor((course.x + FEED_RANGE) / FEED_CELL); cx++) {
        const s = siteIn(cx, cz);
        // Blue whales feed on krill only.
        if (s?.kind !== 'krill' || visited.has(s.id)) continue;
        const dx = s.x - course.x;
        const dz = s.z - course.z;
        const d = Math.hypot(dx, dz);
        if (d >= bestD || dx * fwd.x + dz * fwd.z < 0.2 * d) continue;
        if (!(shore.clearance(s.x, s.z) > WHALE_ISLAND_MARGIN + s.radius + 10)) continue;
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  function endFeed(time: number): void {
    if (site) visited.add(site.id);
    trimOldest(visited, 64);
    site = null;
    feedStart = null;
    behavior = 'travel';
    nextFeed = time + jitter(FEED_GAP[0], FEED_GAP[1]);
  }

  function decide(time: number, shore: Shore): void {
    if (behavior === 'travel') {
      // A floor that has brought the whale up near the surface ends the dive: the climb becomes a surfacing.
      if (floorNeed > SHALLOWEST_DIVE && depth.x > SHALLOWEST_DIVE) nextBreath = Math.min(nextBreath, time);
      if (time >= nextBreath) {
        behavior = 'breathe';
        breathing = false;
      } else if (floorAt && time >= nextFeed && nextBreath - time > FEED_WINDOW) {
        site = findSite(shore);
        if (site) {
          behavior = 'feed';
          nextBreath = Math.max(nextBreath, time + FEED_HOLD);
          siteSince = time;
          lunge = (site.id & 1) === 1;
          circleDir = site.id & 2 ? 1 : -1;
        } else nextFeed = time + 4;
      }
    } else if (behavior === 'feed' && site) {
      const d = Math.hypot(site.x - course.x, site.z - course.z);
      if (feedStart === null && d < site.radius && Math.abs(depth.x - site.y) < site.radius) {
        feedStart = time;
        feedLen = jitter(12, FEED_MAX);
      }
      const done = feedStart !== null ? time - feedStart > feedLen : time - siteSince > APPROACH_SECONDS;
      if (done || time > nextBreath) endFeed(time);
    }
  }

  /** Queue the surfacing: a few blows with a roll back under between them, then the fluke-up dive (now and then a breach and one more blow first). */
  function startBreath(): void {
    breathing = true;
    queue.push(posed('surface', jitter(RISE_LEN[0], RISE_LEN[1])), posed('spout'));
    const blows = blowCount();
    for (let i = 1; i < blows; i++) queue.push(...blow());
    // Blue whales rarely breach.
    if (rng() < BREACH_CHANCE) {
      queue.push(posed('dive'), posed('breach'), posed('splash'), posed('roll', jitter(ROLL_LEN[0], ROLL_LEN[1])));
      queue.push(posed('surface', jitter(RISE_LEN[0], RISE_LEN[1])), posed('spout'));
    }
    queue.push(posed('dive'));
  }

  /**
   * Highest of `rise(floor, ahead)` over the floor along a fan of paths ahead, out to `seconds` at `pace` m/s, read
   * `every` seconds apart: the pilot may turn into a rise, so not only the straight course counts.
   */
  function scanAhead(
    seconds: number,
    every: number,
    pace: number,
    rise: (floor: number, ahead: number) => number,
    turns: readonly number[] = FLOOR_TURNS,
    from = 0,
  ): number {
    let top = -Infinity;
    if (!floorAt) return top;
    for (const rate of turns) {
      let x = course.x;
      let z = course.z;
      for (let ahead = 0; ahead <= seconds; ahead += every) {
        if (ahead >= from) top = Math.max(top, rise(floorAt(x, z), ahead));
        const fwd = whaleForward(course.heading + clamp(rate * (ahead + every / 2), -FLOOR_FAN, FLOOR_FAN));
        x += fwd.x * pace * every;
        z += fwd.z * pace * every;
      }
    }
    return top;
  }

  /**
   * Lowest the rail may run for the floor along the path ahead: high enough to clear every rise there at the capped
   * climb, allowing for the spring's lag, so a rising floor never forces a faster climb.
   */
  const floorRise = (floor: number, ahead: number) => floor + RAIL_CLEARANCE - VERTICAL_SPEED * Math.max(0, ahead - 4 / DEPTH_OMEGA);
  /** The far read, refreshed every few decisions: a deep dive must see a rising floor far enough ahead to climb clear. */
  let farFloor = -Infinity;
  let farAge = Infinity;
  const readFloor = () => {
    if (++farAge >= FLOOR_FAR_DECISIONS) {
      farAge = 0;
      farFloor = depth.x < DIVE_DEPTH[0] / 2 ? scanAhead(FLOOR_FAR, FLOOR_FAR_EVERY, speed, floorRise, FLOOR_FAR_TURNS, FLOOR_AHEAD) : -Infinity;
    }
    return Math.max(scanAhead(FLOOR_AHEAD, 0.5, speed, floorRise), farFloor);
  };

  /** Room for a real dive (the rail clear of the floor below SHALLOWEST_DIVE) all along the next DIVE_ROOM seconds at travel pace. */
  const roomToDive = () => scanAhead(DIVE_ROOM, 0.5, Math.max(speed, TRAVEL_MIN), (floor) => floor + RAIL_CLEARANCE) <= SHALLOWEST_DIVE;

  /** Cruise pose: depth from the spring, nose along the climb or descent, banking into turns. */
  function cruisePose(out: WhalePose): void {
    const near = smoothstep(-3.2 * DEPTH_SCALE, -1.6 * DEPTH_SCALE, depth.x);
    const pace = clamp((speed - 1) / (TRAVEL_MAX - 1), 0, 1);
    out.y = depth.x;
    out.pitch = SWIM_PITCH * near + clamp(Math.atan2(depth.v, Math.max(speed, 1.5)), -0.5, 0.5);
    out.roll = bank;
    out.arch = REST_ARCH * near;
    out.stroke = lerp(0.75, 1.35, pace);
    out.rate = lerp(0.8, 1.7, pace);
    out.flipLift = 0;
    out.flipSweep = 0.08 * (1 - pace);
    out.bob = near;
    out.surge = 0;
  }

  function step(rawDt: number, time: number, shore: Shore): void {
    const dt = Number.isFinite(rawDt) ? Math.max(0, rawDt) : 0;
    if (!(dt > 0) || !Number.isFinite(time)) return;
    const s = Math.floor(time / DECIDE_EVERY);
    if (!forced && s !== slot) {
      slot = s;
      floorNeed = readFloor();
      decide(time, shore);
    }

    // Goals for speed and depth from the behaviour.
    let goalSpeed = travelSpeed(time) * mover.pace;
    let goalDepth = diveDepth(time);
    course.aim = null;
    if (behavior === 'breathe') {
      // The climb keeps the travel pace; the glide starts once the whale is near the top.
      if (!held) goalSpeed *= lerp(BREATH_PACE, 1, smoothstep(-3 * DEPTH_SCALE, -12 * DEPTH_SCALE, depth.x) * (seg ? 0 : 1));
      goalDepth = SHALLOW_Y;
      // The first rise starts once the climb has all but settled, so the body does not lurch into it.
      // Close to the glide depth, so the pose's ease-out of the gap adds no jolt.
      if (!breathing && !seg && depth.x > SHALLOW_Y - 0.08 && depth.v < 0.12) startBreath();
    } else if (behavior === 'feed' && site) {
      const dx = course.x - site.x;
      const dz = course.z - site.z;
      const d = Math.hypot(dx, dz);
      if (feedStart === null) {
        course.aim = site;
        goalSpeed = lerp(APPROACH_SLOW, goalSpeed, smoothstep(30, 240, d));
        // Slow enough to turn onto the swarm: the turning circle through it must fit in the distance left.
        const off = Math.min(Math.PI / 2, Math.max(0.1, Math.abs(shortestAngle(course.heading, headingToward(-dx, -dz)))));
        goalSpeed = Math.min(goalSpeed, Math.max(APPROACH_CREEP, (0.8 * WHALE_MAX_TURN_RATE * d) / (2 * Math.sin(off))));
        goalDepth = lerp(site.y, goalDepth, smoothstep(40, 160, d));
      } else {
        goalDepth = site.y;
        if (lunge) {
          // Pursue the centre: the turn limit swings the whale back through the swarm in loops.
          course.aim = site;
          goalSpeed = LUNGE_SPEED;
        } else {
          const a = Math.atan2(dz, dx) + circleDir * 0.7;
          const r = site.radius + 3;
          course.aim = { x: site.x + Math.cos(a) * r, z: site.z + Math.sin(a) * r };
          goalSpeed = CIRCLE_SPEED;
        }
      }
    }
    if (floorAt) {
      // The floor under the whale and a second ahead, eased.
      const fwd = whaleForward(course.heading);
      let floor = floorAt(course.x, course.z);
      for (const ahead of [0.5, 1]) floor = Math.max(floor, floorAt(course.x + fwd.x * speed * ahead, course.z + fwd.z * speed * ahead));
      motion.floor = springStep(floorEase, floor, FLOOR_OMEGA, dt);
    }
    goalDepth = Math.max(goalDepth, floorNeed);
    // Never above the glide just under the surface: over a shoal the whale skims it, it does not climb out.
    goalDepth = Math.min(goalDepth, SHALLOW_Y);

    // Speed eases toward a smoothed goal with bounded acceleration.
    speedGoal = damp(speedGoal, goalSpeed, 0.6, dt);
    if (forced) speed = 0;
    else speed += clamp((speedGoal - speed) * 0.5, -MAX_DECEL, MAX_ACCEL) * dt;

    const before = course.heading;
    if (!forced) {
      course.speed = speed;
      pilot.step(course, dt, time, shore);
    }
    const rate = shortestAngle(before, course.heading) / dt;
    bank = damp(bank, clamp(rate * speed * 0.12, -0.45, 0.45), 1.5, dt);
    turn = damp(turn, rate, 1.5, dt);

    // Posed segments play in order; between them the whale cruises.
    let phase: WhalePhase;
    let phaseT: number;
    /** Cruise time this step: only what is left after a segment that ended part way through it. */
    let cruiseDt = dt;
    const queued = seg ? undefined : queue.shift();
    if (queued) {
      cruisePose(leave);
      seg = queued;
      whalePose(seg.phase, 0, pick, seg.lift);
    }
    if (seg) seg.t += dt;
    if (seg && seg.t > seg.len) {
      // Past the end: the time left over runs on in the next segment, so no frame holds still.
      const ended = seg.phase;
      const over = seg.t - seg.len;
      // No room to dive along the path ahead: take another blow instead and look again after it.
      if (!forced && queue[0]?.phase === 'dive') {
        held = !roomToDive();
        if (held) queue.unshift(...blow());
      }
      seg = queue.shift() ?? null;
      whalePose(ended, 1, leave);
      if (seg) {
        seg.t = over;
        whalePose(seg.phase, 0, pick, seg.lift);
      } else {
        forced = false;
        cruiseDt = over;
        rail = springSet(depth, leave.y);
        // The fluke-up dive hands its sink on to the long dive.
        if (ended === 'dive') depth.v = -DIVE_SINK;
        cruisePose(pick);
        if (behavior === 'breathe') {
          behavior = 'travel';
          nextBreath = time + jitter(DIVE_MIN, DIVE_MAX);
        }
      }
    }
    if (seg) {
      phase = seg.phase;
      phaseT = clamp(seg.t / seg.len, 0, 1);
      whalePose(phase, phaseT, target, seg.lift);
    } else {
      // The climb and the descent ease off over the last stretch before the goal, as a whale slows before it surfaces.
      const cap = lerp(VERTICAL_EASE, VERTICAL_SPEED, smoothstep(2, 25, Math.abs(goalDepth - rail)));
      rail += clamp(goalDepth - rail, -cap * cruiseDt, cap * cruiseDt);
      springStep(depth, rail, DEPTH_OMEGA, cruiseDt);
      const next: WhalePhase = depth.x < -3.5 * DEPTH_SCALE ? 'deep' : depth.x > -2.8 * DEPTH_SCALE ? 'swim' : label === 'deep' ? 'deep' : 'swim';
      if (next !== label) labelT = 0;
      labelT += dt;
      phase = next;
      phaseT = clamp(labelT / PHASE_LEN[phase], 0, 1);
      cruisePose(target);
    }
    // A change of pose source eases out its mismatch through the offset instead of jumping.
    if (seg !== source) for (const key of POSE_KEYS) offset[key] += leave[key] - pick[key];
    source = seg;
    label = phase;
    const fade = Math.exp(-1.1 * dt);
    for (const key of POSE_KEYS) {
      offset[key] *= fade;
      motion.pose[key] = target[key] + offset[key];
    }

    if (motion.pose.surge !== 0) {
      // Breach carries the whale forward along its heading, even in a forced review.
      const fwd = whaleForward(course.heading);
      course.x += fwd.x * motion.pose.surge * dt;
      course.z += fwd.z * motion.pose.surge * dt;
    }
    motion.x = course.x;
    motion.z = course.z;
    motion.heading = course.heading;
    motion.speed = speed + motion.pose.surge;
    motion.behavior = behavior;
    motion.phase = phase;
    motion.phaseT = phaseT;
    motion.site = site;
    motion.turn = turn;
  }

  const mover: WhaleMover = {
    motion,
    course,
    pace: 1,
    step,
    place(x, z) {
      course.x = motion.x = x;
      course.z = motion.z = z;
    },
    force(phase, t) {
      forced = true;
      queue.length = 0;
      seg = { phase, len: PHASE_LEN[phase], t: PHASE_LEN[phase] * t };
      source = seg;
      site = null;
      feedStart = null;
      behavior = 'travel';
      breathing = false;
      speed = 0;
      label = phase;
      whalePose(phase, t, motion.pose);
      for (const key of POSE_KEYS) offset[key] = 0;
      motion.phase = phase;
      motion.phaseT = t;
      motion.speed = 0;
      motion.behavior = behavior;
      motion.site = null;
    },
  };
  return mover;
}
