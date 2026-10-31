import * as THREE from 'three';
import { clamp, lerp } from './math.js';

/**
 * Pure optics and colour helpers for the underwater view: Snell's window, fog
 * blending across the surface, depth tint and light falloff. No GPU state here.
 */

/** Refractive index of sea water. */
export const WATER_IOR = 1.333;

/** Angle from the vertical beyond which light from above cannot reach the eye (Snell's window edge). */
export function criticalAngle(n = WATER_IOR): number {
  return Math.asin(1 / n);
}

/**
 * Angle from the vertical in air of a ray that leaves the water at `angle` from
 * the vertical, or null when it is totally internally reflected.
 */
export function airAngle(angle: number, n = WATER_IOR): number | null {
  const s = n * Math.sin(Math.abs(angle));
  return s >= 1 ? null : Math.asin(s);
}

export interface FogState { color: THREE.Color; density: number }

/**
 * Fog at submersion `s`: colour lerps linearly, density geometrically, because
 * the two densities differ by two orders of magnitude and a linear blend would
 * jump straight to murk.
 */
export function blendFog(above: FogState, below: FogState, s: number, out: FogState): FogState {
  const t = clamp(s, 0, 1);
  out.color.copy(above.color).lerp(below.color, t);
  const a = Math.max(1e-7, above.density);
  const b = Math.max(1e-7, below.density);
  out.density = a * Math.pow(b / a, t);
  return out;
}

/** Fraction of surface light left at `depth` metres (bluer wavelengths survive longest). */
export function surfaceLight(depth: number): number {
  return Math.exp(-0.055 * Math.max(0, depth));
}

/**
 * Light left at `depth` metres by colour, in clear open ocean: red is gone by about 15 m, green fades by around 50 m
 * and blue reaches a couple of hundred metres (diffuse attenuation of about 0.3, 0.06 and 0.022 per metre).
 */
export function depthLight(depth: number, out: THREE.Color): THREE.Color {
  const d = Math.max(0, depth);
  return out.setRGB(Math.exp(-0.3 * d), Math.exp(-0.06 * d), Math.exp(-0.022 * d));
}

/** Eyes adapt to the dark down to a quarter of the light, and the deep never drops below VISIBLE_LIGHT of the surface's. */
export const ADAPT_GAIN = 4;
export const VISIBLE_LIGHT = 0.08;
const scratch = new THREE.Color();

/** Brightness the adapted eye sees at `depth`, 1 at the surface: dim but never black, so the whale stays in view. */
export function seenLight(depth: number): number {
  depthLight(depth, scratch);
  const luminance = 0.2126 * scratch.r + 0.7152 * scratch.g + 0.0722 * scratch.b;
  return clamp(luminance * ADAPT_GAIN, VISIBLE_LIGHT, 1);
}

/** Underwater look keyed by daylight: shallow and deep display colours (sRGB hex) and fog densities. */
export interface WaterLook { shallow: number; deep: number; density: number; deepDensity: number }

export const WATER_LOOK: WaterLook = {
  shallow: 0x2f8590,
  deep: 0x0c3a4a,
  // FogExp2: visibility (95 %) is ~1.73 / density: clear open-ocean water, about 80 m near the top and 65 m
  // deep, so a 25 m whale stays in view from the trailing camera.
  density: 0.021,
  deepDensity: 0.026,
};

const shallowColor = new THREE.Color();
const deepColor = new THREE.Color();

/**
 * Absorption colour (display space, linear) and density at `depth`; darker and
 * bluer the deeper the eye. `daylight` dims everything for low suns.
 */
export function waterTint(depth: number, daylight: number, out: FogState, look: WaterLook = WATER_LOOK): FogState {
  const k = 1 - Math.exp(-Math.max(0, depth) / 10);
  shallowColor.setHex(look.shallow, THREE.SRGBColorSpace);
  deepColor.setHex(look.deep, THREE.SRGBColorSpace);
  // The water itself darkens toward a deep navy as the light fails with depth.
  out.color.copy(shallowColor).lerp(deepColor, k).multiplyScalar(clamp(daylight, 0.2, 1) * lerp(0.35, 1, seenLight(depth)));
  out.density = look.density + (look.deepDensity - look.density) * k;
  return out;
}
