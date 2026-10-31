/**
 * Level of detail by distance, with hysteresis so an object sitting on a boundary never flickers between levels.
 * `bounds` are ascending distances; level 0 is the most detailed, level `bounds.length` the least.
 */
export const LOD_HYSTERESIS = 0.1;

export function selectLod(current: number, distance: number, bounds: readonly number[], hysteresis = LOD_HYSTERESIS): number {
  let level = Math.max(0, Math.min(bounds.length, current));
  while (level < bounds.length && distance > (bounds[level] ?? 0) * (1 + hysteresis)) level++;
  while (level > 0 && distance < (bounds[level - 1] ?? 0) * (1 - hysteresis)) level--;
  return level;
}
