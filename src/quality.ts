import { item } from './item.js';
export type QualityTier = 'low' | 'medium' | 'high';

export interface QualityOptions {
  mobile?: boolean;
  software?: boolean;
  cores?: number | undefined;
  memory?: number | undefined;
  dpr?: number;
  maxDpr?: number;
  minDpr?: number;
  targetFPS?: number;
}

export interface QualityState {
  mobile: boolean;
  maximum: number;
  minimum: number;
  ratio: number;
  average: number;
  target: number;
  samples: number;
  cooldown: number;
  dpr: number;
  tier: QualityTier;
  initialTier: QualityTier;
  software: boolean;
  waterSize: number;
  landSegments: number;
  changed: string | null;
}

export function selectQualityTier({ mobile = false, software = false, cores = 8, memory = 8 }: QualityOptions = {}): QualityTier {
  if (mobile || software) return 'low';
  return cores <= 4 || memory <= 4 ? 'medium' : 'high';
}

/**
 * What the added world detail may spend per tier: birds updated, ships at full detail, trees, rocks and houses per
 * land tile, people and animals drawn, and the land's bump detail.
 */
export interface DetailBudget { birds: number; ships: number; objects: number; walkers: number; microNormal: 'off' | 'near' | 'full' }

const detailTable: Record<QualityTier, DetailBudget> = {
  low: { birds: 10, ships: 4, objects: 36, walkers: 64, microNormal: 'off' },
  medium: { birds: 16, ships: 6, objects: 70, walkers: 128, microNormal: 'near' },
  high: { birds: 24, ships: 8, objects: 110, walkers: 192, microNormal: 'full' },
};

export function detailFor(tier: QualityTier): DetailBudget {
  return detailTable[tier];
}

const names: QualityTier[] = ['low', 'medium', 'high'];
const caps: Record<QualityTier, number> = { high: 2, medium: 1.5, low: 1.25 };
const waterSizes: Record<QualityTier, number> = { high: 512, medium: 256, low: 256 };
const landSegs: Record<QualityTier, number> = { high: 128, medium: 112, low: 96 };

export function createQuality({
  mobile = false,
  dpr = 1,
  maxDpr,
  minDpr,
  targetFPS,
  software = false,
  cores,
  memory,
}: QualityOptions = {}): QualityState {
  const tier = selectQualityTier({ mobile, software, cores, memory });
  const maximum = Math.min(dpr, maxDpr ?? caps[tier]);
  return {
    mobile,
    maximum,
    minimum: Math.min(maximum, minDpr ?? 0.65),
    ratio: maximum,
    average: 1000 / (targetFPS ?? (mobile ? 30 : 60)),
    target: 1000 / (targetFPS ?? (mobile ? 30 : 60)),
    samples: 0,
    cooldown: 0,
    dpr,
    tier,
    initialTier: tier,
    software,
    waterSize: waterSizes[tier],
    landSegments: landSegs[tier],
    changed: null,
  };
}

export function updateQuality(state: QualityState, milliseconds: number): boolean {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 2000) return false;
  state.average += (milliseconds - state.average) * 0.035;
  if (state.cooldown > 0) {
    state.cooldown -= milliseconds;
    return false;
  }
  state.samples += milliseconds;
  if (state.samples < 3000) return false;
  state.samples = 0;
  const previous = state.ratio;
  state.changed = null;
  if (state.average > state.target * 1.3) {
    if (state.tier !== 'low') {
      state.tier = item(names, names.indexOf(state.tier) - 1);
      state.maximum = Math.min(state.dpr, caps[state.tier]);
      state.ratio = Math.min(state.ratio, state.maximum);
      state.waterSize = waterSizes[state.tier];
      state.landSegments = landSegs[state.tier];
      state.changed = 'tier';
    } else {
      state.ratio = Math.max(state.minimum, state.ratio - 0.15);
    }
  } else if (state.average < state.target * 1.08) {
    state.ratio = Math.min(state.maximum, state.ratio + 0.05);
    if (state.ratio === previous && state.tier !== state.initialTier) {
      state.tier = item(names, names.indexOf(state.tier) + 1);
      state.maximum = Math.min(state.dpr, caps[state.tier]);
      state.waterSize = waterSizes[state.tier];
      state.landSegments = landSegs[state.tier];
      state.changed = 'tier';
    }
  }
  if (previous !== state.ratio || state.changed) {
    state.cooldown = 3000;
    return true;
  }
  return false;
}
