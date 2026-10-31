import { clamp } from './math.js';

/** Answers "how far is land, and which way is open water" for anything afloat. */
export interface Shore {
  /** Distance in metres from (x, z) to the nearest land. Negative means on land. */
  clearance: (x: number, z: number) => number;
  /** Unit XZ direction pointing away from the nearest land. */
  away: (x: number, z: number) => { x: number; z: number };
  /** A cheap, rough `clearance` that works kilometres out (no navigation tile needed); `clearance` when absent. */
  reach?: (x: number, z: number) => number;
}

export interface Circle { x: number; z: number; radius: number }

/** Shore made of round islands. Used by tests and as a simple stand-in. */
export function circleShore(circles: readonly Circle[]): Shore {
  function nearest(x: number, z: number): { circle: Circle | null; gap: number } {
    let best: Circle | null = null;
    let gap = Infinity;
    for (const circle of circles) {
      const d = Math.hypot(x - circle.x, z - circle.z) - circle.radius;
      if (d < gap) {
        gap = d;
        best = circle;
      }
    }
    return { circle: best, gap };
  }
  return {
    clearance(x, z) {
      return nearest(x, z).gap;
    },
    away(x, z) {
      const { circle } = nearest(x, z);
      if (!circle) return { x: 1, z: 0 };
      const dx = x - circle.x;
      const dz = z - circle.z;
      const len = Math.hypot(dx, dz);
      return len > 1e-6 ? { x: dx / len, z: dz / len } : { x: 1, z: 0 };
    },
  };
}

/** Push a point out to at least `margin` metres from land (as far as the water allows). */
export function clampClearOfLand(x: number, z: number, shore: Shore, margin: number): { x: number; z: number } {
  let cx = x;
  let cz = z;
  let gap = shore.clearance(cx, cz);
  // Each step must gain clearance; halve it when it would cross a ridge of the field.
  for (let i = 0; i < 10 && gap < margin; i++) {
    const dir = shore.away(cx, cz);
    let step = clamp(margin - gap, 0, 400) + 1e-3;
    let nx = cx + dir.x * step;
    let nz = cz + dir.z * step;
    let next = shore.clearance(nx, nz);
    while (next <= gap && step > 0.5) {
      step *= 0.5;
      nx = cx + dir.x * step;
      nz = cz + dir.z * step;
      next = shore.clearance(nx, nz);
    }
    if (next <= gap) break;
    cx = nx;
    cz = nz;
    gap = next;
  }
  return { x: cx, z: cz };
}
