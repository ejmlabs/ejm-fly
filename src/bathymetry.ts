/**
 * Ocean depth by distance from the coast, after the real shape of the sea floor:
 * a gentle shelf out to the shelf break (about 140 m), a slope of a few degrees,
 * then an abyssal plain at about 3500 m that the slope eases onto like the
 * continental rise. Islands and islets keep a narrow shelf and drop steeply.
 * Numbers: continental shelf break 120–140 m, slope 3–4°, abyssal plains at
 * 3000–6000 m (Britannica, "continental shelf"; NOAA Ocean Explorer).
 */

export interface ShelfProfile {
  /** Metres from the coast to the shelf break. */
  width: number;
  /** Depth at the shelf break, metres. */
  breakDepth: number;
  /** Slope below the break, degrees. */
  slope: number;
}

/**
 * Continental margins: the steep coasts of this world have active margins, like western South America or Japan,
 * with a shelf of 10 to 20 km and an upper slope of 5 degrees or more, rather than the 65–80 km passive-margin average.
 */
export const CONTINENT: ShelfProfile = { width: 12000, breakDepth: 140, slope: 5 };
/** Island and islet flanks: a fringe of shallows, then a steep volcanic-style drop. */
export const ISLAND: ShelfProfile = { width: 1500, breakDepth: 60, slope: 15 };
/** Abyssal plain depth (metres); the seafloor adds low hills on top. */
export const PLAIN = 3500;
/** How softly the slope bends onto the plain (metres of depth). */
const RISE = 150;

/** Depth (metres, ≥ 0) at `metres` from the coast; 0 on land. Continuous and never shallower further out. */
export function depthForCoastDistance(metres: number, profile: ShelfProfile = CONTINENT): number {
  if (!(metres > 0)) return 0;
  const { width, breakDepth, slope } = profile;
  if (metres <= width) return breakDepth * (metres / width);
  const linear = breakDepth + Math.tan((slope * Math.PI) / 180) * (metres - width);
  return softMin(linear, PLAIN);
}

/** Depth from the distances to the nearest continental coast and to the nearest coast of any land: the shallower profile wins. */
export function seabedDepth(continent: number, coast: number = continent): number {
  return Math.min(depthForCoastDistance(continent, CONTINENT), depthForCoastDistance(coast, ISLAND));
}

/** Smooth minimum: within a few RISE of the lower value it follows it; never above it. */
function softMin(a: number, b: number): number {
  const lo = Math.min(a, b);
  return lo - RISE * Math.log(Math.exp((lo - a) / RISE) + Math.exp((lo - b) / RISE));
}
