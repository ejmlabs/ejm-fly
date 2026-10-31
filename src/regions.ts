import { smoothstep } from './math.js';
import { LATITUDE_SPAN, type Planet } from './planet.js';
import { item } from './item.js';

/** Width over which a border between two regions blends. */
export const REGION_BLEND = 5000;
/** The start keeps its own look: temperate within this distance, the regions whole beyond three times it. */
const HOME = 6000;
/** Open ocean this far (m) from any continent turns deep blue, wholly by the second distance. */
export const DEEP_FROM = 22000;
export const DEEP_FULL = 40000;

export type RegionId = 0 | 1 | 2 | 3;
export type RegionWeights = [number, number, number, number];

/** Everything a region changes. Colours are sRGB hex; factors are multipliers of the scene's own value. */
export interface RegionLook {
  name: string;
  /** Multiplies the offshore islet lift. */
  isletGain: number;
  water: number;
  /** Fog colour is pulled this far toward `fog`. */
  fog: number;
  fogMix: number;
  fogDensity: number;
  hazeDensity: number;
  /** Multiplies the land's vertex colours. */
  land: [number, number, number];
  /** Share of gulls, terns, albatrosses. */
  birds: [number, number, number];
  ships: number;
}

export const REGION_LOOKS: readonly RegionLook[] = [
  { name: 'Temperate', isletGain: 1, water: 0x1a4e68, fog: 0x163e54, fogMix: 0, fogDensity: 1, hazeDensity: 1, land: [1, 1, 1], birds: [0.5, 0.35, 0.15], ships: 0.6 },
  { name: 'Tropical', isletGain: 1.6, water: 0x1e7a8c, fog: 0x2a8a8a, fogMix: 0.35, fogDensity: 0.9, hazeDensity: 0.85, land: [0.94, 1.1, 0.9], birds: [0.2, 0.7, 0.1], ships: 0.5 },
  { name: 'Polar', isletGain: 0.5, water: 0x1a4a62, fog: 0x7e98a8, fogMix: 0.45, fogDensity: 1.5, hazeDensity: 1.4, land: [1.08, 1.1, 1.14], birds: [0.4, 0.05, 0.55], ships: 0.2 },
  { name: 'Deep blue', isletGain: 0.25, water: 0x123e66, fog: 0x1a4a78, fogMix: 0.3, fogDensity: 0.8, hazeDensity: 0.9, land: [1, 1, 1], birds: [0.15, 0.1, 0.75], ships: 0.7 },
];

export interface Regions {
  /** Blend weights (summing to 1) of the four regions at a world position. */
  weightsAt: (x: number, z: number, out?: RegionWeights) => RegionWeights;
  /** Region with the largest weight. */
  dominantAt: (x: number, z: number) => RegionId;
}

/**
 * The four seas on the planet's layout: tropical, temperate and polar by latitude (the bands blend over about
 * 5 km), and deep blue out in open ocean far from any continent. The start is temperate.
 */
export function createRegions(planet: Pick<Planet, 'latitudeAt' | 'openAt'>): Regions {
  const band = REGION_BLEND / 2 / LATITUDE_SPAN;

  function weightsAt(x: number, z: number, out: RegionWeights = [0, 0, 0, 0]): RegionWeights {
    const away = smoothstep(HOME, HOME * 3, Math.hypot(x, z));
    if (away <= 0) {
      out[0] = 1;
      out[1] = out[2] = out[3] = 0;
      return out;
    }
    const latitude = planet.latitudeAt(x, z);
    const deep = smoothstep(DEEP_FROM, DEEP_FULL, planet.openAt(x, z));
    const tropical = 1 - smoothstep(1 / 3 - band, 1 / 3 + band, latitude);
    const polar = smoothstep(2 / 3 - band, 2 / 3 + band, latitude);
    const shelf = away * (1 - deep);
    out[1] = tropical * shelf;
    out[2] = polar * shelf;
    out[3] = deep * away;
    out[0] = Math.max(0, 1 - out[1] - out[2] - out[3]);
    return out;
  }

  const scratch: RegionWeights = [0, 0, 0, 0];
  return {
    weightsAt,
    dominantAt(x, z) {
      weightsAt(x, z, scratch);
      let best = 0;
      for (let k = 1; k < 4; k++) if ((scratch[k] ?? 0) > (scratch[best] ?? 0)) best = k;
      return best as RegionId;
    },
  };
}

/** Weighted sum of one numeric field of the looks. */
export function blendLook(weights: RegionWeights, pick: (look: RegionLook) => number): number {
  let sum = 0;
  for (let k = 0; k < 4; k++) sum += (weights[k] ?? 0) * pick(item(REGION_LOOKS, k));
  return sum;
}
