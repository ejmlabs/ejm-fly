/** A reserve never grows past this, so a job with slower slices still gets its turn. */
const MAX_RESERVE_MS = 1;
/** Each slice forgets this share of the old estimate, so one slow slice (a pause, a cold cache) soon stops mattering. */
const FORGET = 0.97;

/**
 * What one kind of job's slices cost: its longest recent slice. A loop that spends a time budget in slices asks `fits`
 * before it starts another, so it ends at its budget and not a slice past it.
 */
export interface SliceCost {
  /** Whether `leftMs` of the budget can hold another slice. */
  fits: (leftMs: number) => boolean;
  /** Records what a slice took. */
  note: (sliceMs: number) => void;
}

export function createSliceCost(): SliceCost {
  let longest = 0;
  return {
    fits: (leftMs) => leftMs > Math.min(longest, MAX_RESERVE_MS),
    note(sliceMs) {
      longest = Math.max(sliceMs, longest * FORGET);
    },
  };
}
