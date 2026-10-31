import * as THREE from 'three';
import { REGION_LOOKS, blendLook, type Regions, type RegionWeights } from './regions.js';
import { item } from './item.js';

/** The look of the place the whale is in: the four regions' looks, blended by their weights. */
export interface RegionLookState {
  water: THREE.Color;
  fogTint: THREE.Color;
  fogMix: number;
  fogDensity: number;
  hazeDensity: number;
  land: THREE.Color;
  /** Share of gulls, terns, albatrosses. */
  birds: [number, number, number];
  weights: RegionWeights;
  /** Moves the look to world (x, z). */
  update: (x: number, z: number) => void;
}

const water = REGION_LOOKS.map((look) => new THREE.Color(look.water));
const fog = REGION_LOOKS.map((look) => new THREE.Color(look.fog));
const land = REGION_LOOKS.map((look) => new THREE.Color(look.land[0], look.land[1], look.land[2]));

function mix(out: THREE.Color, colors: readonly THREE.Color[], weights: RegionWeights): void {
  out.setRGB(0, 0, 0);
  for (let k = 0; k < 4; k++) {
    out.r += item(colors, k).r * (weights[k] ?? 0);
    out.g += item(colors, k).g * (weights[k] ?? 0);
    out.b += item(colors, k).b * (weights[k] ?? 0);
  }
}

export function createRegionLook(regions: Regions): RegionLookState {
  const state: RegionLookState = {
    water: new THREE.Color(),
    fogTint: new THREE.Color(),
    fogMix: 0,
    fogDensity: 1,
    hazeDensity: 1,
    land: new THREE.Color(),
    birds: [0.5, 0.35, 0.15],
    weights: [1, 0, 0, 0],
    update(x, z) {
      const w = regions.weightsAt(x, z, state.weights);
      mix(state.water, water, w);
      mix(state.fogTint, fog, w);
      mix(state.land, land, w);
      state.fogMix = blendLook(w, (look) => look.fogMix);
      state.fogDensity = blendLook(w, (look) => look.fogDensity);
      state.hazeDensity = blendLook(w, (look) => look.hazeDensity);
      for (let b = 0; b < 3; b++) state.birds[b] = blendLook(w, (look) => look.birds[b] ?? 0);
    },
  };
  state.update(0, 0);
  return state;
}
