import { item } from './item.js';
/**
 * The swell shared by everything that floats: the water surface, ships, the whale and the wakes all ride it, so they
 * agree on where the sea is. Its waves are fixed; only their heights follow the sea level, from glassy to rough.
 */
export interface SwellWave { wavelength: number; amplitude: number; heading: number; speed: number }

/** Wavelengths 40, 17 and 9 m, amplitudes 0.18, 0.07 and 0.03 m: the calm sea, matching the mirror-like water. */
export const SWELL_WAVES: readonly SwellWave[] = [
  { wavelength: 40, amplitude: 0.18, heading: 0.35, speed: 2.5 },
  { wavelength: 17, amplitude: 0.07, heading: 1.2, speed: 1.6 },
  { wavelength: 9, amplitude: 0.03, heading: 2.3, speed: 1.1 },
];

/**
 * Wind waves at full sea level, headings relative to the wind: long rollers with shorter chop across them. Speeds are
 * about two thirds of deep-water speed, as the swell's clock already runs faster while the whale swims.
 */
export const WIND_WAVES: readonly SwellWave[] = [
  { wavelength: 110, amplitude: 1, heading: 0, speed: 8.6 },
  { wavelength: 64, amplitude: 0.6, heading: 0.45, speed: 6.6 },
  { wavelength: 36, amplitude: 0.34, heading: -0.55, speed: 5 },
  { wavelength: 21, amplitude: 0.18, heading: 0.95, speed: 3.8 },
  { wavelength: 12, amplitude: 0.08, heading: -1.2, speed: 2.9 },
];

/** Every wave of the sea, calm first; the shader draws the same list. */
export const SEA_WAVES = SWELL_WAVES.length + WIND_WAVES.length;

/** Largest height the calm swell can reach, either way. */
export const SWELL_MAX = SWELL_WAVES.reduce((sum, wave) => sum + wave.amplitude, 0);
/** Largest height the roughest sea can reach, either way. */
export const SEA_MAX = SWELL_MAX * 1.5 + WIND_WAVES.reduce((sum, wave) => sum + wave.amplitude, 0);

/** The sea now: its level (0 glassy to 1 rough), the wind's direction (radians) and each wave's height and heading. */
const sea = {
  level: 0,
  wind: 0,
  amplitude: new Float64Array(SEA_WAVES),
  dirX: new Float64Array(SEA_WAVES),
  dirZ: new Float64Array(SEA_WAVES),
  k: new Float64Array(SEA_WAVES),
  speed: new Float64Array(SEA_WAVES),
};

function waveOf(i: number): SwellWave {
  return i < SWELL_WAVES.length ? item(SWELL_WAVES, i) : item(WIND_WAVES, i - SWELL_WAVES.length);
}

/** Sets the sea level and the wind's direction for every rider and for the water. */
export function setSea(level: number, wind = sea.wind): void {
  sea.level = Math.min(1, Math.max(0, level));
  sea.wind = wind;
  for (let i = 0; i < SEA_WAVES; i++) {
    const wave = waveOf(i);
    const calm = i < SWELL_WAVES.length;
    const heading = calm ? wave.heading : wind + wave.heading;
    sea.amplitude[i] = wave.amplitude * (calm ? 1 + 0.5 * sea.level : sea.level ** 1.5);
    sea.dirX[i] = Math.cos(heading);
    sea.dirZ[i] = Math.sin(heading);
    sea.k[i] = (Math.PI * 2) / wave.wavelength;
    sea.speed[i] = wave.speed;
  }
}
setSea(0);

export function seaLevel(): number {
  return sea.level;
}

export interface SwellSample { height: number; slopeX: number; slopeZ: number }

/** Surface height (m) and slope (dh/dx, dh/dz) at world (x, z) and time `t` seconds. Writes into `out` when given. */
export function swellAt(x: number, z: number, t: number, out: SwellSample = { height: 0, slopeX: 0, slopeZ: 0 }): SwellSample {
  let height = 0;
  let slopeX = 0;
  let slopeZ = 0;
  for (let i = 0; i < SEA_WAVES; i++) {
    const a = sea.amplitude[i] ?? 0;
    if (a === 0) continue;
    const k = sea.k[i] ?? 0;
    const dx = sea.dirX[i] ?? 0;
    const dz = sea.dirZ[i] ?? 0;
    const phase = k * (x * dx + z * dz) - k * (sea.speed[i] ?? 0) * t;
    height += a * Math.sin(phase);
    const slope = a * k * Math.cos(phase);
    slopeX += slope * dx;
    slopeZ += slope * dz;
  }
  out.height = height;
  out.slopeX = slopeX;
  out.slopeZ = slopeZ;
  return out;
}

/**
 * The waves for a shader, four floats each: direction times wavenumber (x, z), height, and phase at render (0, 0)
 * for a world origin and time, reduced to one turn in double precision so the GPU never sees large numbers.
 */
export function packWaves(originX: number, originZ: number, t: number, out: Float32Array): Float32Array {
  const turn = Math.PI * 2;
  for (let i = 0; i < SEA_WAVES; i++) {
    const k = sea.k[i] ?? 0;
    const phase = k * (originX * (sea.dirX[i] ?? 0) + originZ * (sea.dirZ[i] ?? 0)) - k * (sea.speed[i] ?? 0) * t;
    out[i * 4] = (sea.dirX[i] ?? 0) * k;
    out[i * 4 + 1] = (sea.dirZ[i] ?? 0) * k;
    out[i * 4 + 2] = sea.amplitude[i] ?? 0;
    out[i * 4 + 3] = phase - Math.floor(phase / turn) * turn;
  }
  return out;
}

/** How much faster the sea's clock runs at the top cruise speed than at rest (it runs 2.5 times as fast). */
export const SWELL_SPEED_GAIN = 1.5;

/** Rate of the swell's clock for a share of the top cruise speed, 0 to 1: the sea slides by faster the faster the whale swims. */
export function swellRate(speedShare: number): number {
  return 1 + SWELL_SPEED_GAIN * Math.min(1, Math.max(0, speedShare));
}
