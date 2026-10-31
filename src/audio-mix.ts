import { BREACH_EXIT, BREACH_SPLASH, type WhalePhase } from './whale-motion.js';
import { clamp, smoothstep } from './math.js';
import { item } from './item.js';

/** Pure mixing rules for the sound: what plays, how loud, and where. No Web Audio here. */

/** Seconds into gulls.ogg and length of each call (written by tools/build-audio.py). */
export const GULL_CALLS: readonly (readonly [number, number])[] = [
  [0, 3],
  [3.5, 4.5],
  [8.5, 4.5],
  [13.5, 6],
];

/** The two hits in splash.ogg: a lighter rush and the heavy re-entry. */
export const SPLASH_HITS: readonly (readonly [number, number])[] = [
  [0, 3.27],
  [3.77, 4.09],
];

/** Whale moments that make a sound, as bit flags so detection never allocates. */
export const WHALE_SPOUT = 1;
export const WHALE_BREACH_EXIT = 2;
export const WHALE_BREACH_SPLASH = 4;
export const WHALE_DIVE = 8;
export const WHALE_SURFACE = 16;

export interface WhaleMoment { phase: WhalePhase; phaseT: number }

/**
 * Lookback, in normalised phase time, when a phase starts or jumps backwards. A
 * natural transition starts near 0, so its thresholds still fire; a forced jump
 * deep into a phase does not replay the moments it skipped.
 */
const ENTRY_WINDOW = 0.05;

/** Events between two consecutive whale states. Each fires once, at its transition. */
export function whaleEvents(prev: WhaleMoment, cur: WhaleMoment): number {
  let events = 0;
  const entered = prev.phase !== cur.phase;
  const rewound = !entered && cur.phaseT < prev.phaseT;
  if (entered) {
    if (cur.phase === 'spout') events |= WHALE_SPOUT;
    else if (cur.phase === 'dive') events |= WHALE_DIVE;
    else if (cur.phase === 'surface') events |= WHALE_SURFACE;
  }
  if (cur.phase === 'breach') {
    const from = entered || rewound ? Math.max(0, cur.phaseT - ENTRY_WINDOW) : prev.phaseT;
    if (from < BREACH_EXIT && cur.phaseT >= BREACH_EXIT) events |= WHALE_BREACH_EXIT;
    if (from < BREACH_SPLASH && cur.phaseT >= BREACH_SPLASH) events |= WHALE_BREACH_SPLASH;
  }
  return events;
}

/** Surf heard from a coast `clearance` metres away: full on the beach, gone by ~700 m. */
export function surfGain(clearance: number): number {
  const d = Math.max(0, clearance);
  return clamp(1 / (1 + (d / 90) ** 2) - 0.015, 0, 1) * (1 - smoothstep(450, 700, d));
}

export const GULL_RANGE = 400;

/** Gulls stay near land: loud close in, silent past GULL_RANGE metres. */
export function gullGain(clearance: number): number {
  return 1 - smoothstep(GULL_RANGE * 0.25, GULL_RANGE, Math.max(0, clearance));
}

/** Wind rises with height above the sea: a breeze at the waterline, fuller aloft. */
export function windGain(height: number): number {
  return 0.22 + 0.5 * smoothstep(1, 45, height);
}

/** Rain on the sea: nothing in a dry sky, full in a downpour. */
export function rainGain(rain: number): number {
  return 0.8 * smoothstep(0.02, 0.9, rain);
}

/** The wind bed swells with the weather's wind (0 still to 1 gale). */
export function weatherWindGain(wind: number): number {
  return 0.8 + 1.5 * clamp(wind, 0, 1);
}

/** The open-sea bed grows with the sea (0 glassy to 1 rough). */
export function seaGain(sea: number): number {
  return 1 + 0.8 * clamp(sea, 0, 1);
}

/** Open-sea bed: a little quieter right by a loud surf line. */
export function oceanGain(clearance: number): number {
  return 0.7 - 0.25 * (1 - smoothstep(30, 300, Math.max(0, clearance)));
}

export interface Muffle { cutoff: number; above: number; below: number }

export const MUFFLE_OPEN = 18000;
export const MUFFLE_CLOSED = 500;

/**
 * Underwater crossfade by submersion (0 above, 1 below): the above-water mix
 * closes through a lowpass from MUFFLE_OPEN to MUFFLE_CLOSED Hz on an exponential
 * sweep and drops to a dull residue while the underwater bed rises.
 */
export function muffle(submersion: number, out: Muffle = { cutoff: MUFFLE_OPEN, above: 1, below: 0 }): Muffle {
  const s = clamp(submersion, 0, 1);
  out.cutoff = MUFFLE_OPEN * (MUFFLE_CLOSED / MUFFLE_OPEN) ** s;
  out.above = Math.cos(s * Math.PI * 0.5) * 0.7 + 0.3;
  out.below = Math.sin(s * Math.PI * 0.5);
  return out;
}

export const SHIP_RANGE = 650;

/** Engine hum from a ship `distance` metres away. */
export function engineGain(distance: number): number {
  return clamp(1 / (1 + (distance / 45) ** 2), 0, 1) * (1 - smoothstep(SHIP_RANGE * 0.6, SHIP_RANGE, distance));
}

/** Bow wash only carries a short way. */
export function washGain(distance: number): number {
  return clamp(1 / (1 + (distance / 25) ** 2), 0, 1) * (1 - smoothstep(120, 260, distance));
}

/** Horns carry: audible across the bay, softening with distance. */
export function hornGain(distance: number): number {
  return clamp(0.9 / (1 + distance / 220), 0, 0.9);
}

export interface ShipPoint { id: number; x: number; z: number }

/**
 * Indices into `ships` of the nearest `max` within `range` of (x, z), nearest
 * first, ties broken by id so the choice never flickers. Writes into `out` and
 * `scratch` (reused arrays) and returns the count.
 */
export function nearestShips(
  ships: readonly ShipPoint[],
  x: number,
  z: number,
  max: number,
  range: number,
  out: number[],
  scratch: number[],
): number {
  let count = 0;
  for (let i = 0; i < ships.length; i++) {
    const ship = item(ships, i);
    const d = Math.hypot(ship.x - x, ship.z - z);
    if (d > range) continue;
    // Insertion into the sorted top-`max` list.
    let at = count;
    while (at > 0) {
      const j = out[at - 1] ?? 0;
      const dj = scratch[at - 1] ?? 0;
      if (dj < d || (dj === d && item(ships, j).id < ship.id)) break;
      at--;
    }
    if (at >= max) continue;
    for (let k = Math.min(count, max - 1); k > at; k--) {
      out[k] = out[k - 1] ?? 0;
      scratch[k] = scratch[k - 1] ?? 0;
    }
    out[at] = i;
    scratch[at] = d;
    if (count < max) count++;
  }
  return count;
}
