/** How a species is built and how it swims: a fish beats its tail, a ray flaps its wings, a jellyfish pulses its bell. */
export type FishShape = 'fish' | 'ray' | 'jelly';

export interface FishSpecies {
  name: 'sardine' | 'mackerel' | 'tuna' | 'lanternfish' | 'jellyfish' | 'ray' | 'reef';
  shape: FishShape;
  /** Body length (m); a ray's disc width, a jellyfish's bell width. Meshes are built at unit length. */
  length: number;
  /** Body height and width as fractions of the length. */
  height: number;
  width: number;
  /** Depth range (m below the surface) the species keeps to. */
  depth: readonly [number, number];
  /** Fish in a school (min, max); 1 swims alone. */
  school: readonly [number, number];
  /** Where it lives: open blue water, over the shelf, on reefs, or anywhere. */
  habitat: 'open' | 'shelf' | 'reef' | 'any';
  back: number;
  belly: number;
  /** Tail beats (or wing strokes, or bell pulses) per second at cruise. */
  beat: number;
  /** Side-to-side amplitude at the tail (or wing tip lift, or bell squeeze), as a fraction of the length. */
  sway: number;
  /** Light of its own (0..1), drawn in `glowColor`. */
  glow: number;
  glowColor: number;
}

/**
 * Tail-beat rates follow Bainbridge (1958), speed ≈ 0.75 × length × beat, at a
 * cruise of one to two body lengths a second; tail amplitude is about a fifth
 * of the length (Videler 1993). Depths from FishBase.
 */
export const FISH_SPECIES: readonly FishSpecies[] = [
  { name: 'sardine', shape: 'fish', length: 0.2, height: 0.2, width: 0.12, depth: [0, 200], school: [300, 900], habitat: 'any', back: 0x3c5f78, belly: 0xd8e2e6, beat: 4, sway: 0.2, glow: 0, glowColor: 0 },
  { name: 'mackerel', shape: 'fish', length: 0.35, height: 0.18, width: 0.12, depth: [0, 200], school: [120, 400], habitat: 'shelf', back: 0x2f5b4f, belly: 0xe2e6dc, beat: 3, sway: 0.18, glow: 0, glowColor: 0 },
  { name: 'tuna', shape: 'fish', length: 1.6, height: 0.26, width: 0.18, depth: [0, 300], school: [10, 40], habitat: 'open', back: 0x1d2c4a, belly: 0xc9ced4, beat: 1.4, sway: 0.12, glow: 0, glowColor: 0 },
  { name: 'lanternfish', shape: 'fish', length: 0.08, height: 0.22, width: 0.12, depth: [200, 1000], school: [200, 800], habitat: 'open', back: 0x2a2e38, belly: 0x5d6470, beat: 5, sway: 0.22, glow: 0.8, glowColor: 0x5fd6ff },
  { name: 'jellyfish', shape: 'jelly', length: 0.35, height: 0.5, width: 1, depth: [0, 1000], school: [1, 12], habitat: 'any', back: 0xc8b8d8, belly: 0xe8dcef, beat: 0.6, sway: 0.16, glow: 0.25, glowColor: 0xb59cff },
  { name: 'ray', shape: 'ray', length: 1.8, height: 0.08, width: 1, depth: [0, 150], school: [1, 6], habitat: 'shelf', back: 0x3b3a36, belly: 0xe6e3dc, beat: 0.4, sway: 0.18, glow: 0, glowColor: 0 },
  { name: 'reef', shape: 'fish', length: 0.18, height: 0.42, width: 0.1, depth: [0, 40], school: [8, 40], habitat: 'reef', back: 0xe0a33a, belly: 0xf3e3b0, beat: 3.5, sway: 0.2, glow: 0, glowColor: 0 },
];
