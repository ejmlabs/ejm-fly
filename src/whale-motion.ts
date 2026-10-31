import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './math.js';
import { DEPTH_SCALE, WHALE_LENGTH } from './whale-size.js';

export type WhalePhase = 'swim' | 'surface' | 'spout' | 'roll' | 'dive' | 'deep' | 'breach' | 'splash';

export const PHASE_LEN: Record<WhalePhase, number> = {
  swim: 18,
  surface: 4,
  spout: 4.5,
  roll: 7,
  dive: 10,
  deep: 60,
  breach: 5.5,
  splash: 2.5,
};

/**
 * A surfacing is a string of blows, each a rise, a spout and a roll back under; the last blow ends in the
 * fluke-up dive and the long stretch at depth. Now and then a breach follows the dive.
 */
export const PHASE_ORDER: WhalePhase[] = ['deep', 'surface', 'spout', 'roll', 'surface', 'spout', 'dive', 'breach', 'splash', 'roll', 'surface', 'spout', 'dive'];

/**
 * Body-origin heights and resting trim. Near the surface the whale rides
 * slightly nose-up with its tail stock sagging: the head crown, blowholes,
 * back line and fin break the water; the tail stays under. Heights against the waterline follow how deep
 * the body is (DEPTH_SCALE).
 */
export const DEEP_Y = -4.5 * DEPTH_SCALE;
export const SWIM_Y = -0.4 * DEPTH_SCALE;
/** Cruising depth of the long dive between surfacings. */
export const DEEP_DIVE_Y = -14 * DEPTH_SCALE;
/** Sinking rate (m/s) the fluke-up dive hands on to the long dive. */
export const DIVE_SINK = 1;
/** Smallest gap kept between the body origin and the seafloor. */
export const FLOOR_CLEARANCE = 3 * DEPTH_SCALE;
export const SURFACE_Y = -0.7 * DEPTH_SCALE;
/**
 * Glide depth between blows: the back is just under, well above the camera's dive line,
 * so the chase view stays on the surface through a whole surfacing.
 */
export const SHALLOW_Y = -1.9 * DEPTH_SCALE;
export const SWIM_PITCH = 0.04;
export const SURFACE_PITCH = 0.085;
export const REST_ARCH = -0.4;
export const GRAVITY = 9.81;

/**
 * Breach timeline as fractions of the breach phase: a powered rise from depth,
 * a ballistic flight, then re-entry and a slow recovery under the splash.
 */
export const BREACH_EXIT = 0.16;
export const BREACH_EXIT_Y = -1 * DEPTH_SCALE;
/** Body-origin height at the top of a breach: a blue whale lifts most of its body clear, rarely all of it. */
export const BREACH_APEX_Y = 0.18 * WHALE_LENGTH;
export const BREACH_V0 = Math.sqrt(2 * GRAVITY * (BREACH_APEX_Y - BREACH_EXIT_Y));
export const BREACH_AIR_TIME = (2 * BREACH_V0) / GRAVITY;
export const BREACH_LAND = BREACH_EXIT + BREACH_AIR_TIME / PHASE_LEN.breach;
export const BREACH_APEX = (BREACH_EXIT + BREACH_LAND) * 0.5;
/** Body-origin height where the falling whale first strikes the water. */
export const BREACH_CONTACT_Y = 1 * DEPTH_SCALE;
/** Phase time of that strike: the re-entry splash fires here. */
export const BREACH_SPLASH =
  BREACH_EXIT + (BREACH_V0 + Math.sqrt(BREACH_V0 ** 2 - 2 * GRAVITY * (BREACH_CONTACT_Y - BREACH_EXIT_Y))) / GRAVITY / PHASE_LEN.breach;
const BREACH_LOW = BREACH_LAND + 0.08;
const BREACH_END_Y = -2.2 * DEPTH_SCALE;
const BREACH_LOW_Y = -4.6 * DEPTH_SCALE;
const EXIT_PITCH = 1.22;
/** Still nose-down when it hits: the body crashes through instead of landing flat. */
export const LAND_PITCH = -0.5;
/** Roll at re-entry; the whale comes down on its side. */
export const BREACH_ROLL = 1.75;
/** Extra forward speed (m/s) through the rise and flight, on top of the cruise. */
export const BREACH_SURGE = 2.4;

export interface WhalePose {
  /** Body-origin height. */
  y: number;
  /** Nose-up angle, radians. */
  pitch: number;
  /** Roll about the body axis, radians (breach roll is unsigned; callers pick a side). */
  roll: number;
  /** Dorsal arch: head down, tail up. */
  arch: number;
  /** Fluke stroke amplitude multiplier. */
  stroke: number;
  /** Stroke rate multiplier. */
  rate: number;
  /** Flipper abduction away from the rest droop (negative lifts them out). */
  flipLift: number;
  /** Flipper sweep away from rest (negative brings them forward). */
  flipSweep: number;
  /** Weight of the idle bob/roll that only makes sense near the surface. */
  bob: number;
  /** Extra forward speed along the heading, m/s. */
  surge: number;
}

export function emptyPose(): WhalePose {
  return { y: 0, pitch: 0, roll: 0, arch: 0, stroke: 1, rate: 1, flipLift: 0, flipSweep: 0, bob: 1, surge: 0 };
}

function hermite(y0: number, v0: number, y1: number, v1: number, duration: number, s: number): number {
  const t = clamp(s, 0, 1);
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * v0 * duration + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * v1 * duration;
}

/** Smooth 0→1→0 bump that is flat at both ends. */
function bump(t: number, a: number, b: number, c: number, d: number): number {
  return smoothstep(a, b, t) * (1 - smoothstep(c, d, t));
}

/** Breach body height. Exactly ballistic between exit and re-entry. */
export function breachHeight(t: number): number {
  const T = PHASE_LEN.breach;
  if (t < BREACH_EXIT) return hermite(DEEP_Y, -DIVE_SINK, BREACH_EXIT_Y, BREACH_V0, BREACH_EXIT * T, t / BREACH_EXIT);
  if (t <= BREACH_LAND) {
    const s = (t - BREACH_EXIT) * T;
    return BREACH_EXIT_Y + BREACH_V0 * s - 0.5 * GRAVITY * s * s;
  }
  if (t < BREACH_LOW) {
    return hermite(BREACH_EXIT_Y, -BREACH_V0, BREACH_LOW_Y, 0, (BREACH_LOW - BREACH_LAND) * T, (t - BREACH_LAND) / (BREACH_LOW - BREACH_LAND));
  }
  return hermite(BREACH_LOW_Y, 0, BREACH_END_Y, 0, (1 - BREACH_LOW) * T, (t - BREACH_LOW) / (1 - BREACH_LOW));
}

/** True while the body is clear of the water's grip and following its arc. */
export function breachAirborne(t: number): boolean {
  return t >= BREACH_EXIT && t <= BREACH_LAND;
}

/**
 * Pose for a phase at normalised time t. Each phase ends exactly where the next
 * one in PHASE_ORDER begins, so the cycle needs no smoothing to stay continuous.
 */
/** `lift` scales how high a fluke-up dive raises the flukes (1 full, toward 0 a dive that keeps them under). */
export function whalePose(phase: WhalePhase, t: number, out: WhalePose = emptyPose(), lift = 1): WhalePose {
  const x = clamp(t, 0, 1);
  out.roll = 0;
  out.arch = 0;
  out.flipLift = 0;
  out.flipSweep = 0;
  out.rate = 1;
  out.surge = 0;
  switch (phase) {
    case 'swim': {
      // Climb back from the dive, then cruise with the back awash.
      const rise = smoothstep(0, 0.3, x);
      out.y = lerp(DEEP_Y, SWIM_Y, rise);
      out.pitch = SWIM_PITCH * rise + 0.1 * Math.sin(Math.PI * clamp(x / 0.3, 0, 1));
      out.arch = REST_ARCH * rise;
      out.stroke = 1;
      out.bob = rise;
      out.flipLift = -0.12 * Math.sin(Math.PI * clamp(x / 0.3, 0, 1));
      break;
    }
    case 'surface': {
      // Rise from the glide into a blow: the head leads up, the back settles awash.
      out.y = lerp(SHALLOW_Y, SURFACE_Y, smoothstep(0, 0.8, x));
      out.pitch = SURFACE_PITCH * smoothstep(0, 1, x) + 0.1 * bump(x, 0, 0.35, 0.5, 0.9);
      out.arch = REST_ARCH * smoothstep(0.2, 1, x);
      out.stroke = lerp(1, 0.6, smoothstep(0.3, 1, x));
      out.bob = smoothstep(0.2, 1, x);
      out.flipLift = -0.12 * bump(x, 0, 0.3, 0.5, 1);
      break;
    }
    case 'spout':
      // The exhale lifts the head a little.
      out.y = SURFACE_Y + 0.08 * DEPTH_SCALE * Math.sin(Math.PI * x);
      out.pitch = SURFACE_PITCH + 0.02 * Math.sin(Math.PI * x);
      out.arch = REST_ARCH;
      out.stroke = 0.6;
      out.bob = 1;
      break;
    case 'roll': {
      // After a blow the head dips first and the back rolls over, fin last, then the body glides just under.
      out.y = lerp(SURFACE_Y, SHALLOW_Y, smoothstep(0.1, 0.7, x));
      out.pitch = SURFACE_PITCH * (1 - smoothstep(0, 0.25, x)) - 0.1 * bump(x, 0.1, 0.35, 0.5, 0.85);
      // The back humps as the head goes down while the tail stock still hangs low: the flukes stay
      // under (only the last dive lifts them out).
      out.arch = REST_ARCH * (1 - smoothstep(0.3, 0.85, x)) + 0.3 * bump(x, 0.05, 0.3, 0.45, 0.8);
      out.stroke = lerp(0.6, 1, smoothstep(0.3, 0.9, x));
      out.bob = 1 - smoothstep(0.2, 0.75, x);
      out.flipSweep = 0.1 * bump(x, 0.2, 0.5, 0.7, 1);
      break;
    }
    case 'dive': {
      // Fluke-up: the back humps high, the tail stock arches out and the flukes lift clear,
      // then the whale slides under and keeps sinking into the long dive.
      const sink = x < 0.45 ? 0 : hermite(0, 0, DEEP_Y - SURFACE_Y + 1.2 * DEPTH_SCALE, -DIVE_SINK, 0.55 * PHASE_LEN.dive, (x - 0.45) / 0.55);
      out.y = SURFACE_Y - 1.2 * DEPTH_SCALE * smoothstep(0.08, 0.5, x) + sink;
      out.pitch = SURFACE_PITCH * (1 - smoothstep(0, 0.15, x)) - 0.62 * lift * bump(x, 0.05, 0.4, 0.6, 0.97);
      out.arch = REST_ARCH * (1 - smoothstep(0, 0.15, x)) + 0.8 * lift * bump(x, 0.04, 0.38, 0.55, 0.95);
      // The flukes hang still while they are out of the water, then drive the body down.
      out.stroke = lerp(0.6, 1, smoothstep(0.6, 1, x)) * (1 - 0.7 * bump(x, 0.2, 0.35, 0.55, 0.7));
      out.rate = 1 - 0.4 * bump(x, 0.2, 0.35, 0.55, 0.75);
      out.bob = 1 - smoothstep(0, 0.45, x);
      out.flipLift = -0.15 * bump(x, 0, 0.3, 0.6, 1);
      out.flipSweep = 0.25 * bump(x, 0.3, 0.6, 0.8, 1);
      break;
    }
    case 'deep': {
      // Sound down from the dive, glide along at depth with a slow undulation, then climb back to the glide depth.
      const down = smoothstep(0, 0.2, x);
      const up = smoothstep(0.75, 1, x);
      out.y = lerp(lerp(DEEP_Y, DEEP_DIVE_Y, down), SHALLOW_Y, up) + 0.9 * DEPTH_SCALE * Math.sin(Math.PI * 4 * x) * bump(x, 0.12, 0.3, 0.7, 0.88);
      out.pitch = -0.22 * bump(x, 0, 0.06, 0.12, 0.22) + 0.24 * bump(x, 0.78, 0.86, 0.92, 1) - 0.05 * Math.cos(Math.PI * 4 * x) * bump(x, 0.12, 0.3, 0.7, 0.88);
      const glide = bump(x, 0.18, 0.3, 0.7, 0.82);
      out.stroke = 1 - 0.3 * glide;
      out.rate = 1 - 0.25 * glide;
      out.flipSweep = 0.08 * glide;
      out.bob = 0;
      break;
    }
    case 'breach': {
      out.y = breachHeight(x);
      const air = bump(x, BREACH_EXIT - 0.06, BREACH_EXIT + 0.03, BREACH_SPLASH - 0.02, BREACH_SPLASH + 0.08);
      if (x < BREACH_EXIT) {
        out.pitch = EXIT_PITCH * smoothstep(0.01, BREACH_EXIT * 0.92, x);
      } else if (x <= BREACH_SPLASH) {
        const k = (x - BREACH_EXIT) / (BREACH_SPLASH - BREACH_EXIT);
        // Nose falls slowly at first, faster as the body tips over the apex.
        out.pitch = lerp(EXIT_PITCH, LAND_PITCH, smoothstep(0, 1, k) * 0.6 + k * 0.4);
      } else {
        // Keeps diving nose-first through the splash, levels out once deep.
        out.pitch = LAND_PITCH * (1 - smoothstep(BREACH_LOW, 0.85, x));
      }
      // Roll onto the side in the air; unroll only once well under.
      out.roll = BREACH_ROLL * smoothstep(BREACH_EXIT - 0.02, BREACH_SPLASH, x) * (1 - smoothstep(BREACH_LOW, 1, x));
      out.surge = BREACH_SURGE * bump(x, 0.02, 0.1, BREACH_SPLASH - 0.04, BREACH_LOW);
      out.arch = -0.12 * air;
      // Hard strokes on the way up, near-still in the air, easing back afterwards.
      const powered = 1 + 1.1 * bump(x, 0, 0.05, 0.12, BREACH_EXIT) - 0.2 * smoothstep(BREACH_LAND, 1, x);
      out.stroke = lerp(powered, 0.25, air);
      out.rate = 1 + 0.9 * bump(x, 0, 0.04, 0.12, BREACH_EXIT);
      out.flipLift = -0.95 * air;
      out.flipSweep = -0.4 * air;
      out.bob = 0;
      break;
    }
    case 'splash':
      out.y = lerp(BREACH_END_Y, SURFACE_Y, smoothstep(0, 1, x));
      out.pitch = SURFACE_PITCH * smoothstep(0, 1, x) + 0.06 * Math.sin(Math.PI * x);
      out.arch = REST_ARCH * smoothstep(0, 1, x);
      out.stroke = lerp(0.8, 0.6, x);
      out.bob = smoothstep(0, 1, x);
      break;
  }
  return out;
}

/** Width of the blend into the floor limit, metres. */
const FLOOR_SOFT = 1.5 * DEPTH_SCALE;

/**
 * Keeps the body origin at least FLOOR_CLEARANCE above the seafloor. A C1 soft
 * maximum (never below max(y, limit)) eases the whale onto a rising floor
 * instead of stopping it dead. Over very shallow ground the limit is capped
 * below the surface-riding height so the floor never lifts the whale out.
 */
export function floorLimit(y: number, floorY: number | undefined): number {
  if (floorY === undefined || !Number.isFinite(floorY)) return y;
  const limit = Math.min(floorY + FLOOR_CLEARANCE, SURFACE_Y - FLOOR_SOFT);
  const u = y - limit;
  // Tolerance: surface riding sits exactly on the blend edge and must pass through untouched.
  if (u >= FLOOR_SOFT - 1e-9) return y;
  if (u <= -FLOOR_SOFT) return limit;
  return limit + ((u + FLOOR_SOFT) * (u + FLOOR_SOFT)) / (4 * FLOOR_SOFT);
}

export const POSE_KEYS: (keyof WhalePose)[] = ['y', 'pitch', 'roll', 'arch', 'stroke', 'rate', 'flipLift', 'flipSweep', 'bob', 'surge'];

/* ---------------------------------------------------------------- spine */

/** Per-bone stroke amplitude (radians) and phase lag, head → tail. */
const TAIL_AMP = [0.022, 0.04, 0.065, 0.1, 0.22];
const TAIL_ARCH = [0.05, 0.09, 0.13, 0.15, 0.06];
const HEAD_AMP = [0.012, 0.008];
const WAVE_LAG = 0.62;

export interface SpineAngles { head: number[]; tail: number[] }

/**
 * Bend angles about the body Z axis for a travelling wave that runs head → fluke.
 * Positive tail angles lift the tail; positive head angles drop the head.
 */
export function spineAngles(strokePhase: number, stroke: number, arch: number, out: SpineAngles = { head: [0, 0], tail: [0, 0, 0, 0, 0] }): SpineAngles {
  for (let i = 0; i < TAIL_AMP.length; i++) {
    out.tail[i] = stroke * (TAIL_AMP[i] ?? 0) * Math.sin(strokePhase - (i + 1) * WAVE_LAG) + arch * (TAIL_ARCH[i] ?? 0);
  }
  for (let i = 0; i < HEAD_AMP.length; i++) {
    out.head[i] = -stroke * (HEAD_AMP[i] ?? 0) * Math.sin(strokePhase + 0.4) + arch * 0.12;
  }
  return out;
}

/* ---------------------------------------------------------------- orientation */

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const qa = new THREE.Quaternion();

/**
 * Yaw about world Y (head along whaleForward(heading)), then nose-up pitch, then
 * roll about the body's own long axis.
 */
export function whaleOrientation(heading: number, pitch: number, roll: number, out = new THREE.Quaternion()): THREE.Quaternion {
  out.setFromAxisAngle(Y_AXIS, heading);
  // Head is on −X, so nose-up is a negative turn about Z.
  out.multiply(qa.setFromAxisAngle(Z_AXIS, -pitch));
  out.multiply(qa.setFromAxisAngle(X_AXIS, roll));
  return out;
}
