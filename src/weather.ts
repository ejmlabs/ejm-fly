import { hash } from './rng.js';
import { clamp, lerp, smoothstep } from './math.js';
import type { RegionWeights } from './regions.js';
import { item } from './item.js';

export type WeatherState = 'clear' | 'hazy' | 'overcast' | 'rain' | 'storm' | 'fog';

/** What a weather state sets, as multipliers or fractions of the sky's own values. */
export interface WeatherLook {
  /** Cloud cover and density, as absolute values for the sky shader. */
  coverage: number;
  density: number;
  /** Multiplies the sea fog's density and the land haze. */
  fog: number;
  haze: number;
  /** Multiplies the sun's light; the sky's own light (hemisphere, ambient) is lifted a little when the sun is veiled. */
  sun: number;
  /** How far fog and haze colours are pulled toward a grey of their own brightness. */
  grey: number;
  /** Rain, 0 to 1. */
  rain: number;
  /** Wind, 0 (still) to 1 (gale): ripples, spray, rain slant and the wind's sound. */
  wind: number;
  /** How much the storm darkens the sky and its light, 0 to 1. */
  dark: number;
  /** Sea level, 0 (glassy swells) to 1 (rough): in a state, the sea its wind drives; in the look, the sea now, which lags the wind. */
  sea: number;
  /** Lightning now, 0 to 1. */
  flash: number;
}

export const WEATHER: Record<WeatherState, WeatherLook> = {
  clear: { coverage: 0.17, density: 0.15, fog: 1, haze: 1, sun: 1, grey: 0, rain: 0, wind: 0.12, dark: 0, sea: 0, flash: 0 },
  hazy: { coverage: 0.34, density: 0.2, fog: 1.7, haze: 1.2, sun: 0.78, grey: 0.12, rain: 0, wind: 0.2, dark: 0, sea: 0.12, flash: 0 },
  overcast: { coverage: 0.82, density: 0.45, fog: 1.25, haze: 1.05, sun: 0.38, grey: 0.5, rain: 0, wind: 0.4, dark: 0.15, sea: 0.35, flash: 0 },
  rain: { coverage: 0.9, density: 0.6, fog: 1.9, haze: 1.3, sun: 0.22, grey: 0.62, rain: 0.7, wind: 0.62, dark: 0.35, sea: 0.62, flash: 0 },
  storm: { coverage: 0.95, density: 0.75, fog: 2.2, haze: 1.45, sun: 0.1, grey: 0.7, rain: 1, wind: 1, dark: 0.62, sea: 1, flash: 0 },
  fog: { coverage: 0.92, density: 0.7, fog: 9, haze: 14, sun: 0.4, grey: 0.85, rain: 0, wind: 0.05, dark: 0.05, sea: 0.05, flash: 0 },
};

/** The ladder the weather walks, a rung at a time; fog is a bank of its own on top. */
export const LADDER: readonly WeatherState[] = ['clear', 'hazy', 'overcast', 'rain', 'storm'];
export const WEATHER_STATES: readonly WeatherState[] = [...LADDER, 'fog'];

const KEYS = Object.keys(WEATHER.clear) as (keyof WeatherLook)[];

/** Seconds between the walk's knots for a seed: 200 to 360, so each seed holds its weather for its own while. */
export function weatherSpan(seed: number): number {
  return 200 + 160 * unit(seed, 5101, 0);
}

/** Share of a span the weather holds before and after a change; the change itself takes the middle 40 percent (80 s or more). */
const HOLD = 0.3;
/** Chance of a step up and a step down the ladder at each knot: the walk spends most of its time fair. */
const UP = 0.28;
const DOWN = 0.42;
/** Weather bias of the regions (temperate, tropical, polar, deep blue), in ladder fractions. */
const BIAS = [0.04, -0.06, 0.12, 0];
/** How readily fog banks form in each region. */
const FOG_ODDS = [0.8, 0.3, 1, 0.55];
/** The sea moves toward the wind's sea at most this fast (per second): seas build and fall over minutes. */
export const SEA_RATE = 1 / 150;
/** Lightning: at most one flash per this many seconds, which rises over FLASH_RISE and fades over about a second. */
export const FLASH_CELL = 6;
export const FLASH_RISE = 0.15;
const FLASH_FADE = 3.5;
const FLASH_LENGTH = 1.4;

function unit(seed: number, channel: number, index: number): number {
  return hash(seed, channel, index) / 0x100000000;
}

/** Eased position between two knots: held at both ends, a smooth change in the middle. */
function ease(t: number): number {
  return smoothstep(HOLD, 1 - HOLD, t);
}

/** The seeded tracks of a seed: the ladder walk, fog banks and distant swell, each a pure function of the clock. */
export interface WeatherTrack {
  span: number;
  /** Ladder position, 0 (clear) to 1 (storm), before the region's bias. */
  ladder: (clock: number) => number;
  /** Fog bank strength before the region and wind thin it, 0 to 1. */
  bank: (clock: number) => number;
  /** Sea level of a swell from distant weather, 0 to about 0.45. */
  swell: (clock: number) => number;
}

export function weatherTrack(seed: number): WeatherTrack {
  const span = weatherSpan(seed);
  // Rungs of the walk, knot by knot; knot 0 is clear so the opening is as composed.
  const rungs = [0];
  const rung = (k: number): number => {
    while (rungs.length <= k) {
      const at = rungs.length;
      const last = rungs[at - 1] ?? 0;
      const roll = unit(seed, 5003, at);
      const up = last === 0 ? UP + 0.07 : UP;
      const down = last === LADDER.length - 1 ? DOWN + 0.18 : DOWN;
      rungs.push(roll < up ? Math.min(LADDER.length - 1, last + 1) : roll < up + down ? Math.max(0, last - 1) : last);
    }
    return rungs[k] ?? 0;
  };
  const sampled = (clock: number, length: number, knot: (k: number) => number): number => {
    const at = Math.max(0, clock) / length;
    const k = Math.floor(at);
    return lerp(knot(k), knot(k + 1), ease(at - k));
  };
  return {
    span,
    ladder: (clock) => sampled(clock, span, (k) => rung(k) / (LADDER.length - 1)),
    bank: (clock) => sampled(clock, span * 1.6, (k) => (k > 0 && unit(seed, 5007, k) < 0.2 ? 1 : 0)),
    swell: (clock) => sampled(clock, span * 2.3, (k) => (k > 0 ? 0.45 * unit(seed, 5011, k) ** 2 : 0)),
  };
}

/** Where on the ladder the weather is, 0 (clear) to 1 (storm), after the region's bias; clear skies stay clear. */
export function severityAt(track: WeatherTrack, clock: number, weights: RegionWeights): number {
  const s = track.ladder(clock);
  let bias = 0;
  for (let r = 0; r < 4; r++) bias += (weights[r] ?? 0) * (BIAS[r] ?? 0);
  return clamp(s + bias * smoothstep(0, 0.25, s), 0, 1);
}

/** Fog bank strength now: the region's odds, and gone when the wind gets up. */
export function fogAt(track: WeatherTrack, clock: number, weights: RegionWeights, severity: number): number {
  let odds = 0;
  for (let r = 0; r < 4; r++) odds += (weights[r] ?? 0) * (FOG_ODDS[r] ?? 0);
  return track.bank(clock) * odds * (1 - smoothstep(0.35, 0.65, severity));
}

/**
 * Lightning at `clock` for a storm share of 0 to 1: each FLASH_CELL may hold one flash at a seeded moment, and a cell
 * right after a flash holds none, so flashes start at least FLASH_CELL seconds apart. Soft: it rises over FLASH_RISE.
 */
export function flashAt(seed: number, clock: number, storm: number): number {
  if (storm <= 0) return 0;
  const cell = Math.floor(clock / FLASH_CELL);
  const chance = 0.55 * storm;
  if (unit(seed, 7001, cell) >= chance || unit(seed, 7001, cell - 1) < chance) return 0;
  const since = clock - (cell * FLASH_CELL + unit(seed, 7002, cell) * (FLASH_CELL - FLASH_LENGTH));
  if (since < 0 || since > FLASH_LENGTH) return 0;
  const strength = 0.5 + 0.5 * unit(seed, 7003, cell);
  const shape = since < FLASH_RISE ? since / FLASH_RISE : Math.exp(-(since - FLASH_RISE) * FLASH_FADE);
  return strength * shape * (1 - smoothstep(FLASH_LENGTH - 0.3, FLASH_LENGTH, since));
}

/** The look on the ladder at a severity: neighbouring states blended. */
function ladderLook(severity: number, clearCover: number, out: WeatherLook): WeatherLook {
  const at = clamp(severity, 0, 1) * (LADDER.length - 1);
  const i = Math.min(LADDER.length - 2, Math.floor(at));
  const a = WEATHER[item(LADDER, i)];
  const b = WEATHER[item(LADDER, i + 1)];
  const t = at - i;
  for (const key of KEYS) out[key] = lerp(a[key], b[key], t);
  // The seed's own clear-sky cover stands in for the clear state.
  if (i === 0) out.coverage = lerp(clearCover, b.coverage, t);
  return out;
}

export interface Weather {
  /** The look right now; moved by `update`. */
  readonly look: WeatherLook;
  /** The state that shows most right now. */
  target: () => WeatherState;
  /** `clock` is seconds of the experience; `weights` the region blend where the whale is. `flashes` false holds the lightning off (reduced motion). */
  update: (dt: number, clock: number, weights: RegionWeights, flashes?: boolean) => WeatherLook;
  /** Jump to a state, its sea included, and hold it (review shots). */
  set: (state: WeatherState) => void;
  /** Hold the sea at a level, or null to let it follow the weather again (review shots). */
  setSea: (level: number | null) => void;
}

/**
 * Weather on a seeded walk up and down the ladder clear, hazy, overcast, rain, storm, a rung per knot, held for minutes
 * and eased over at least 80 s; fog banks come and go on a track of their own, and the sea follows the wind over minutes.
 */
export function createWeather(seed: number, cover = WEATHER.clear.coverage): Weather {
  const track = weatherTrack(seed);
  const look: WeatherLook = { ...WEATHER.clear, coverage: cover };
  const fogLook: WeatherLook = { ...WEATHER.fog };
  let forced: WeatherState | null = null;
  let heldSea: number | null = null;
  let severity = 0;
  let fog = 0;
  let sea = 0;

  /** Sets the look for a severity and fog; returns the sea the wind drives. */
  function apply(): number {
    ladderLook(severity, cover, look);
    for (const key of KEYS) look[key] = lerp(look[key], fogLook[key], fog);
    return look.sea;
  }

  return {
    look,
    target() {
      if (forced) return forced;
      return fog > 0.5 ? 'fog' : item(LADDER, Math.round(severity * (LADDER.length - 1)));
    },
    update(dt, clock, weights, flashes = true) {
      if (forced === null) {
        severity = severityAt(track, clock, weights);
        fog = fogAt(track, clock, weights, severity);
      }
      const driven = Math.max(apply(), forced === null ? track.swell(clock) : 0);
      sea = heldSea ?? sea + clamp(driven - sea, -SEA_RATE * dt, SEA_RATE * dt);
      look.sea = sea;
      look.flash = flashes ? flashAt(seed, clock, smoothstep(0.8, 1, severity) * (1 - fog)) : 0;
      return look;
    },
    set(state) {
      if (!WEATHER_STATES.includes(state)) return;
      forced = state;
      fog = state === 'fog' ? 1 : 0;
      severity = state === 'fog' ? 0 : LADDER.indexOf(state) / (LADDER.length - 1);
      sea = heldSea ?? apply();
      look.sea = sea;
      look.flash = 0;
    },
    setSea(level) {
      heldSea = level === null ? null : clamp(level, 0, 1);
      if (heldSea !== null) sea = look.sea = heldSea;
    },
  };
}
