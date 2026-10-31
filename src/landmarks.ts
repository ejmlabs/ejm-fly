import { hash } from './rng.js';

/** One rock or islet sits in every cell of this lattice (metres), well inside it. */
export const LANDMARK_CELL = 2000;
const MARGIN = 0.2;
const RADIUS_MIN = 30;
const RADIUS_MAX = 90;
/** The footprint reaches this many radii at most. */
const REACH = 2.2;
/** Tallest the lift gets; far above the open sea's mask, so a landmark always breaks the surface. */
const PEAK = 2.6;
/** Largest islet gain a caller may pass (the radius grows with its square root). */
const GAIN_MAX = 1.7;

export interface Landmark { x: number; z: number; radius: number }

export interface Landmarks {
  /** The landmark of lattice cell (i, j), whether or not it stands (see `createLandmarks`). */
  cell: (i: number, j: number) => Landmark;
  /** Lift to add to the land mask at (x, z): 0 away from the landmark of its cell. The radius grows with the square root of `gain` (a region's islet gain, at most 1.7). */
  at: (x: number, z: number, gain?: number) => number;
  /** Forgets which landmarks stand: call when the land underneath changes (the search for the opening offset). */
  reset: () => void;
}

/**
 * Seeded rocks and islets spaced across the sea, one per 2 km cell: something always passes within reach of the route.
 * A cell whose landmark `isOpen` says is not in open water (near a coast, where it could narrow a passage) has none.
 */
export function createLandmarks(seed: number, isOpen: (landmark: Landmark) => boolean = () => true): Landmarks {
  const salt = hash(seed, 17);
  const unit = (i: number, j: number, k: number): number => hash(salt, i, j, k) / 0x100000000;
  // Samples come in runs (a tile, a plan, a ring), so the last cell is kept.
  let ci = NaN;
  let cj = NaN;
  let cell: Landmark = { x: 0, z: 0, radius: 0 };
  let open = false;
  let checking = false;
  // Whether each cell's landmark stands is worked out once (a run of samples crosses cell borders both ways).
  const stands = new Map<number, boolean>();

  function cellAt(i: number, j: number): Landmark {
    return {
      x: (i + MARGIN + (1 - 2 * MARGIN) * unit(i, j, 0)) * LANDMARK_CELL,
      z: (j + MARGIN + (1 - 2 * MARGIN) * unit(i, j, 1)) * LANDMARK_CELL,
      // Many more rocks than islets.
      radius: RADIUS_MIN + (RADIUS_MAX - RADIUS_MIN) * unit(i, j, 2) ** 2,
    };
  }

  return {
    cell: cellAt,
    reset() {
      stands.clear();
      ci = NaN;
      cj = NaN;
    },
    at(x, z, gain = 1) {
      const i = Math.floor(x / LANDMARK_CELL);
      const j = Math.floor(z / LANDMARK_CELL);
      if (checking) return 0;
      if (i !== ci || j !== cj) {
        cell = cellAt(i, j);
        ci = i;
        cj = j;
        const key = i * 65536 + j;
        let known = stands.get(key);
        if (known === undefined) {
          checking = true;
          known = isOpen(cell);
          checking = false;
          if (stands.size > 4096) stands.clear();
          stands.set(key, known);
        }
        open = known;
      }
      if (!open) return 0;
      const dx = x - cell.x;
      const dz = z - cell.z;
      const d2 = dx * dx + dz * dz;
      const widest = cell.radius * REACH;
      if (d2 >= widest * widest * GAIN_MAX) return 0;
      const reach = widest * Math.sqrt(gain);
      const t = d2 / (reach * reach);
      if (t >= 1) return 0;
      return PEAK * (1 - t) * (1 - t);
    },
  };
}
