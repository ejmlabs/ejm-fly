import { hash } from './rng.js';

/** A bait ball or krill swarm under water. World metres; `y` is the swarm centre (negative, below the surface). */
export interface FeedSite {
  /** Stable for (seed, cell). */
  id: number;
  kind: 'krill' | 'baitball';
  x: number;
  y: number;
  z: number;
  /** Swarm radius in metres. */
  radius: number;
}

/** Sites are seeded per square cell of this size, at most one per cell. */
export const FEED_CELL = 600;
/** Fraction of cells that hold a site (before the depth check). */
const DENSITY = 0.45;
/** Numeric salt: string salts all hash alike (see rng.ts). */
const SALT = 0x4645;

const unit = (seed: number, cx: number, cz: number, k: number) => hash(seed, SALT, cx, cz, k) / 0x100000000;

/**
 * The site in cell (cx, cz), or null. Depends only on the seed, the cell and
 * `floorAt` (seafloor height, negative under water): a site needs water at
 * least twice its size plus 8 m deep, and sits clear of floor and surface.
 */
export function feedSiteInCell(seed: number, cx: number, cz: number, floorAt: (x: number, z: number) => number): FeedSite | null {
  if (unit(seed, cx, cz, 0) >= DENSITY) return null;
  const x = (cx + 0.15 + 0.7 * unit(seed, cx, cz, 1)) * FEED_CELL;
  const z = (cz + 0.15 + 0.7 * unit(seed, cx, cz, 2)) * FEED_CELL;
  const kind = unit(seed, cx, cz, 3) < 0.5 ? 'krill' : 'baitball';
  // Krill gather in big swarms deep by day; fish bait balls are smaller and shallower.
  const radius = kind === 'krill' ? 14 + 12 * unit(seed, cx, cz, 4) : 3 + 3 * unit(seed, cx, cz, 4);
  const floor = floorAt(x, z);
  if (!(floor < -(2 * radius + 8))) return null;
  const preferred = kind === 'krill' ? -80 - 120 * unit(seed, cx, cz, 5) : -6 - 10 * unit(seed, cx, cz, 5);
  const y = Math.min(-radius - 2, Math.max(floor + radius + 3, preferred));
  return { id: hash(seed, SALT, cx, cz), kind, x, y, z, radius };
}

/** Sites in every cell overlapping the square of half-size `range` around (x, z), nearest first. */
export function feedSitesNear(
  seed: number,
  x: number,
  z: number,
  range: number,
  floorAt: (x: number, z: number) => number,
): FeedSite[] {
  const out: FeedSite[] = [];
  const x0 = Math.floor((x - range) / FEED_CELL);
  const x1 = Math.floor((x + range) / FEED_CELL);
  const z0 = Math.floor((z - range) / FEED_CELL);
  const z1 = Math.floor((z + range) / FEED_CELL);
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      const site = feedSiteInCell(seed, cx, cz, floorAt);
      if (site) out.push(site);
    }
  }
  return out.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
}
