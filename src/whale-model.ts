import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp, smoothstep } from './math.js';
import { WHALE_LENGTH } from './whale-size.js';
import { item } from './item.js';

/**
 * Blue whale anatomy in metres, local frame:
 * head on −X, tail on +X, back on +Y, left flank on +Z.
 * The body tube runs from the rostrum (u = 0) to the fluke insertion (u = 1);
 * the flukes reach past it so the whole animal is WHALE_LENGTH long.
 * Every length is a share of WHALE_LENGTH, so resizing the whale is one constant.
 */
export { WHALE_LENGTH } from './whale-size.js';
const L = WHALE_LENGTH;
export const HEAD_X = -0.48 * L;
export const TAIL_X = 0.45 * L;
export const BODY_LENGTH = TAIL_X - HEAD_X;
/** Blue whale flippers are short, slender and pointed: about an eighth of the length. */
export const FLIPPER_LENGTH = 0.13 * L;
/** Broad flukes, about a quarter of the length tip to tip. */
export const FLUKE_HALF_SPAN = 0.13 * L;
/** Fluke trailing edge depth from the insertion: a small centre notch versus the lobes. */
export const FLUKE_NOTCH_CHORD = 0.032 * L;
export const FLUKE_LOBE_CHORD = 0.058 * L;
/** How far the flipper root sinks into the body. */
const FLIPPER_SINK = 0.0625 * FLIPPER_LENGTH;

export type WhaleDetail = 'high' | 'medium' | 'low';

export interface DetailSpec {
  rings: number;
  radial: number;
  flipperSpan: number;
  flipperLoop: number;
  flukeSpan: number;
  flukeLoop: number;
}

export const WHALE_DETAIL: Record<WhaleDetail, DetailSpec> = {
  high: { rings: 300, radial: 96, flipperSpan: 40, flipperLoop: 14, flukeSpan: 56, flukeLoop: 16 },
  medium: { rings: 132, radial: 52, flipperSpan: 22, flipperLoop: 10, flukeSpan: 32, flukeLoop: 12 },
  low: { rings: 40, radial: 18, flipperSpan: 10, flipperLoop: 6, flukeSpan: 14, flukeLoop: 6 },
};

/** Camera distances where each level takes over, per quality tier. */
export const WHALE_LOD: Record<'high' | 'medium' | 'low', { detail: WhaleDetail; distance: number }[]> = {
  high: [
    { detail: 'high', distance: 0 },
    { detail: 'medium', distance: 4.6 * L },
    { detail: 'low', distance: 11.7 * L },
  ],
  medium: [
    { detail: 'medium', distance: 0 },
    { detail: 'low', distance: 7.5 * L },
  ],
  low: [
    { detail: 'medium', distance: 0 },
    { detail: 'low', distance: 5 * L },
  ],
};

/* ---------------------------------------------------------------- profile */

// Side and top outline, sampled along u, as shares of WHALE_LENGTH. Dorsal and ventral lines are absolute
// heights; width is the half-width. A blue whale is slender: the body is about an eighth as deep as it is
// long. The head is broad and flat (U-shaped from above, wider than it is deep), the throat deepens back to
// the navel, and the long tail stock is laterally compressed.
const PU = [0, 0.02, 0.05, 0.1, 0.16, 0.22, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.88, 0.95, 1];
const PTOP = [0.004, 0.012, 0.02, 0.03, 0.04, 0.048, 0.054, 0.056, 0.052, 0.044, 0.034, 0.025, 0.017, 0.011, 0.008];
const PBOT = [-0.004, -0.014, -0.028, -0.044, -0.056, -0.062, -0.066, -0.064, -0.056, -0.044, -0.032, -0.022, -0.015, -0.01, -0.007];
const PWID = [0.006, 0.022, 0.034, 0.043, 0.049, 0.053, 0.057, 0.058, 0.054, 0.045, 0.033, 0.022, 0.013, 0.008, 0.006];

/** Splashguard: the raised ridge in front of the blowholes, centred here along u. */
export const SPLASHGUARD_U = 0.172;
/** Blowholes just behind the splashguard. */
export const BLOWHOLE_U = 0.19;
/** Body x of the blowholes, for placing the blow. */
export const BLOWHOLE_X = HEAD_X + BLOWHOLE_U * BODY_LENGTH;

function curve(xs: number[], ys: number[], x: number): number {
  // Monotone cubic (Fritsch–Carlson) so the outline never overshoots.
  const n = xs.length;
  if (x <= (xs[0] ?? 0)) return ys[0] ?? 0;
  if (x >= (xs[n - 1] ?? 0)) return ys[n - 1] ?? 0;
  let i = 0;
  while (x > (xs[i + 1] ?? 0)) i++;
  const slope = (k: number) => {
    if (k <= 0) return ((ys[1] ?? 0) - (ys[0] ?? 0)) / ((xs[1] ?? 0) - (xs[0] ?? 0));
    if (k >= n - 1) return ((ys[n - 1] ?? 0) - (ys[n - 2] ?? 0)) / ((xs[n - 1] ?? 0) - (xs[n - 2] ?? 0));
    const a = ((ys[k] ?? 0) - (ys[k - 1] ?? 0)) / ((xs[k] ?? 0) - (xs[k - 1] ?? 0));
    const b = ((ys[k + 1] ?? 0) - (ys[k] ?? 0)) / ((xs[k + 1] ?? 0) - (xs[k] ?? 0));
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  };
  const h = (xs[i + 1] ?? 0) - (xs[i] ?? 0);
  const t = (x - (xs[i] ?? 0)) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * (ys[i] ?? 0) +
    (t3 - 2 * t2 + t) * h * slope(i) +
    (-2 * t3 + 3 * t2) * (ys[i + 1] ?? 0) +
    (t3 - t2) * h * slope(i + 1)
  );
}

export interface Profile {
  u: number;
  x: number;
  top: number;
  bot: number;
  width: number;
  mid: number;
  topExp: number;
  botExp: number;
  hump: number;
  fin: number;
  guard: number;
  ridge: number;
  jawY: number;
  jaw: number;
}

/** Dorsal fin height along u: small and falcate, about three quarters of the way back. */
export function dorsalFin(u: number): number {
  // Rises off the back to a small swept tip, then drops away steeply behind it.
  return 0.014 * L * smoothstep(0.735, 0.775, u) ** 1.8 * (1 - smoothstep(0.776, 0.795, u));
}

export function sampleProfile(u: number): Profile {
  const top = curve(PU, PTOP, u) * L;
  const bot = curve(PU, PBOT, u) * L;
  const width = curve(PU, PWID, u) * L;
  // Widest line sits below the middle: broad belly, narrower back.
  const mid = bot + (top - bot) * 0.46;
  // The mouth runs back about a quarter of the body.
  const jaw = smoothstep(0, 0.03, u) * (1 - smoothstep(0.2, 0.235, u));
  return {
    u,
    x: HEAD_X + u * BODY_LENGTH,
    top,
    bot,
    width,
    mid,
    // Flat-topped rostrum, rounder body, keeled tail stock.
    topExp: lerp(2.8, 2.15, smoothstep(0.05, 0.3, u)) - 0.15 * smoothstep(0.75, 0.95, u),
    botExp: 2.2 - 0.55 * smoothstep(0.72, 0.92, u),
    // A low dorsal keel runs from behind the fin to the flukes.
    hump: 0.0025 * L * smoothstep(0.79, 0.86, u) * (1 - smoothstep(0.96, 1, u)),
    fin: dorsalFin(u),
    guard: 0.006 * L * Math.exp(-(((u - SPLASHGUARD_U) / 0.014) ** 2)),
    // A single median ridge runs from the splashguard down the rostrum.
    ridge: 0.0016 * L * smoothstep(0.01, 0.05, u) * (1 - smoothstep(0.15, SPLASHGUARD_U, u)),
    // Mouth line drops gently from the rostrum toward the eye.
    jawY: bot + (top - bot) * lerp(0.55, 0.4, clamp(u / 0.22, 0, 1)),
    jaw,
  };
}

function signedPow(v: number, e: number): number {
  return Math.sign(v) * Math.abs(v) ** e;
}

/**
 * Point on the skin for ring profile `p` at angle `theta`
 * (0 = dorsal midline, π/2 = left flank, π = belly).
 */
export function crossSection(p: Profile, theta: number, out: { y: number; z: number }): { y: number; z: number } {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const exp = c >= 0 ? p.topExp : p.botExp;
  let z = p.width * signedPow(s, 2 / exp);
  let y = c >= 0 ? p.mid + (p.top - p.mid) * signedPow(c, 2 / exp) : p.mid + (p.mid - p.bot) * signedPow(c, 2 / exp);
  if (c > 0) {
    // Keel, fin, splashguard and rostral ridge ride on the dorsal midline.
    const fromTop = Math.atan2(Math.abs(s), c);
    y += p.hump * c ** 4 + p.fin * Math.exp(-((fromTop / 0.11) ** 2));
    y += p.guard * Math.exp(-((fromTop / 0.35) ** 2)) + p.ridge * Math.exp(-((fromTop / 0.1) ** 2));
  }
  if (p.jaw > 0) {
    // Lower jaw sits slightly proud of the upper; a soft crease marks the mouth line.
    const d = y - p.jawY;
    const flank = Math.abs(s);
    z *= 1 + 0.045 * p.jaw * flank * (1 - smoothstep(-0.01 * L, 0.0025 * L, d));
    z *= 1 - 0.035 * p.jaw * flank * Math.exp(-((d / (0.0046 * L)) ** 2));
  }
  out.y = y;
  out.z = z;
  return out;
}

/* ---------------------------------------------------------------- skeleton */

export interface BoneSpec { name: string; x: number; parent: number }

/** Spine bone stations along u (shares of the body), head→tail. */
const SPINE_U = [0.094, 0.245, 0.434, 0.604, 0.745, 0.849, 0.934, 1];
const spineX = (i: number) => HEAD_X + (SPINE_U[i] ?? 0) * BODY_LENGTH;
/** Spine bones sorted head→tail; B0 is the root near the centre of mass. */
export const SPINE: BoneSpec[] = [
  { name: 'H2', x: spineX(0), parent: 1 },
  { name: 'H1', x: spineX(1), parent: 2 },
  { name: 'B0', x: spineX(2), parent: -1 },
  { name: 'B1', x: spineX(3), parent: 2 },
  { name: 'B2', x: spineX(4), parent: 3 },
  { name: 'B3', x: spineX(5), parent: 4 },
  { name: 'B4', x: spineX(6), parent: 5 },
  { name: 'B5', x: TAIL_X, parent: 6 },
];
export const ROOT_BONE = 2;
export const FLUKE_BONE = 7;
export const FLIPPER_L = 8;
export const FLIPPER_R = 9;
/** The fluke blades behind the peduncle: they flex after the stroke, so the tips follow through. */
export const FLUKE_FLEX = 10;
/** Outer half of each flipper: it bends behind the inner half. */
export const FLIPPER_TIP_L = 11;
export const FLIPPER_TIP_R = 12;
export const BONE_COUNT = 13;
/** Where the flex bones sit: metres behind the fluke insertion, and the span fraction of the flipper. */
export const FLUKE_FLEX_X = 0.04 * L;
export const FLIPPER_TIP_S = 0.45;

export function spineY(x: number): number {
  const p = sampleProfile(clamp((x - HEAD_X) / BODY_LENGTH, 0, 1));
  return (p.top + p.bot) * 0.5;
}

/** Flipper root on the lower flank behind the head, slightly inside the skin. */
export const FLIPPER_ROOT_U = 0.275;
export function flipperRoot(side: 1 | -1): THREE.Vector3 {
  const p = sampleProfile(FLIPPER_ROOT_U);
  const point = crossSection(p, Math.PI * 0.5 + 0.62, { y: 0, z: 0 });
  return new THREE.Vector3(p.x, p.mid + (point.y - p.mid) * 0.9, side * point.z * 0.86);
}

/** Rest orientation: droop down and sweep back, mirrored for the right side. */
export const FLIPPER_DROOP = 0.62;
export const FLIPPER_SWEEP = 0.5;
export function flipperQuaternion(side: 1 | -1, droop: number, sweep: number, twist: number, out = new THREE.Quaternion()): THREE.Quaternion {
  const qy = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, side * sweep);
  const qx = new THREE.Quaternion().setFromAxisAngle(X_AXIS, side * droop);
  const qz = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, side * twist);
  return out.copy(qy).multiply(qx).multiply(qz);
}
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/* ---------------------------------------------------------------- geometry */

interface Part {
  positions: number[];
  uvs: number[];
  indices: number[];
  skinIndex: number[];
  skinWeight: number[];
  /** Pairs of vertex indices that share a position and must share a normal. */
  seams: [number, number][];
}

function newPart(): Part {
  return { positions: [], uvs: [], indices: [], skinIndex: [], skinWeight: [], seams: [] };
}

function spineWeights(x: number): [number, number, number, number] {
  const first = item(SPINE, 0);
  const last = item(SPINE, SPINE.length - 1);
  if (x <= first.x) return [0, 0, 1, 0];
  if (x >= last.x) return [SPINE.length - 1, 0, 1, 0];
  let i = 0;
  while (x > item(SPINE, i + 1).x) i++;
  const t = smoothstep(0, 1, (x - item(SPINE, i).x) / (item(SPINE, i + 1).x - item(SPINE, i).x));
  return [i, i + 1, 1 - t, t];
}

/** Ring stations packed toward the head, the splashguard, the dorsal fin and the tail. */
export function ringStations(count: number): number[] {
  const samples = 400;
  const cdf: number[] = [0];
  const density = (u: number) =>
    1 +
    1.5 * Math.exp(-((u / 0.12) ** 2)) +
    0.6 * Math.exp(-(((u - SPLASHGUARD_U) / 0.03) ** 2)) +
    1.1 * Math.exp(-(((u - 0.775) / 0.04) ** 2)) +
    0.5 * Math.exp(-(((u - 1) / 0.12) ** 2));
  for (let i = 1; i <= samples; i++) cdf.push((cdf[i - 1] ?? 0) + density((i - 0.5) / samples));
  const total = cdf[samples] ?? 0;
  const out: number[] = [];
  let k = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / (count - 1)) * total;
    while (k < samples && (cdf[k + 1] ?? 0) < target) k++;
    const span = (cdf[k + 1] ?? 0) - (cdf[k] ?? 0);
    const f = span > 0 ? (target - (cdf[k] ?? 0)) / span : 0;
    out.push(clamp((k + f) / samples, 0, 1));
  }
  out[0] = 0;
  out[count - 1] = 1;
  return out;
}

/** Atlas regions: body on the top three quarters, flippers and flukes below. */
export const ATLAS_BODY_V = 0.25;

function buildBody(spec: DetailSpec, part: Part): void {
  const stations = ringStations(spec.rings);
  const R = spec.radial;
  const tmp = { y: 0, z: 0 };
  const ringStart: number[] = [];
  for (let i = 0; i < stations.length; i++) {
    const u = stations[i] ?? 0;
    // Keep a small first ring; the rostrum closes on a tip vertex. Remapped rather than clamped, so dense
    // stations near the tip never collapse onto one ring.
    const p = sampleProfile(0.004 + u * 0.996);
    const w = spineWeights(p.x);
    ringStart.push(part.positions.length / 3);
    for (let j = 0; j <= R; j++) {
      // Seam on the ventral midline, where it is least visible.
      const theta = Math.PI + (j / R) * Math.PI * 2;
      crossSection(p, theta, tmp);
      part.positions.push(p.x, tmp.y, tmp.z);
      part.uvs.push(u, ATLAS_BODY_V + (1 - ATLAS_BODY_V) * (j / R));
      part.skinIndex.push(w[0], w[1], 0, 0);
      part.skinWeight.push(w[2], w[3], 0, 0);
    }
    part.seams.push([ringStart[i] ?? 0, (ringStart[i] ?? 0) + R]);
  }
  for (let i = 0; i < stations.length - 1; i++) {
    const a0 = ringStart[i] ?? 0;
    const b0 = ringStart[i + 1] ?? 0;
    for (let j = 0; j < R; j++) {
      const a = a0 + j;
      const b = b0 + j;
      part.indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  // Caps: rostrum tip and a closed tail end hidden inside the fluke root.
  const caps: { ring: number; x: number; flip: boolean; u: number }[] = [
    { ring: 0, x: HEAD_X - 0.0033 * L, flip: true, u: 0 },
    { ring: stations.length - 1, x: TAIL_X + 0.005 * L, flip: false, u: 1 },
  ];
  for (const cap of caps) {
    const p = sampleProfile(cap.u);
    const tip = part.positions.length / 3;
    const w = spineWeights(cap.x);
    part.positions.push(cap.x, cap.u === 0 ? p.mid + 0.0017 * L : (p.top + p.bot) * 0.5, 0);
    part.uvs.push(cap.u, ATLAS_BODY_V + (1 - ATLAS_BODY_V) * 0.5);
    part.skinIndex.push(w[0], w[1], 0, 0);
    part.skinWeight.push(w[2], w[3], 0, 0);
    const start = ringStart[cap.ring] ?? 0;
    for (let j = 0; j < R; j++) {
      if (cap.flip) part.indices.push(tip, start + j + 1, start + j);
      else part.indices.push(tip, start + j, start + j + 1);
    }
  }
}

/** Approximate NACA 00xx half-thickness at chord fraction k (0 = leading edge). */
function foil(k: number): number {
  const x = clamp(k, 0, 1);
  return 5 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
}

export interface FlipperStation { le: number; chord: number; thick: number }

/** Flipper planform at span fraction s: short, slender, lightly swept, pointed, with a smooth leading edge. */
export function flipperStation(s: number): FlipperStation {
  const chord = FLIPPER_LENGTH * (0.17 * (0.85 + 0.15 * Math.sin(Math.PI * clamp(s * 1.3, 0, 1))) * Math.sqrt(Math.max(0, 1 - s ** 2.2)) + 0.006);
  const sweep = 0.12 * FLIPPER_LENGTH * s * s;
  return {
    le: sweep - chord * 0.3,
    chord,
    thick: FLIPPER_LENGTH * (0.03 * (1 - 0.7 * s) + 0.004),
  };
}

function buildFlipper(spec: DetailSpec, side: 1 | -1, bone: number, tipBone: number, part: Part): void {
  const root = flipperRoot(side);
  const rest = flipperQuaternion(side, FLIPPER_DROOP, FLIPPER_SWEEP, 0);
  const S = spec.flipperSpan;
  const C = spec.flipperLoop;
  const v = new THREE.Vector3();
  const base = part.positions.length / 3;
  for (let i = 0; i <= S; i++) {
    const s = i / S;
    const st = flipperStation(s);
    // Root sinks into the body; blend its weight with the trunk.
    const trunk = 1 - smoothstep(0.02, 0.14, s);
    const tip = smoothstep(0.3, 0.75, s);
    const start = part.positions.length / 3;
    for (let j = 0; j <= C; j++) {
      const phi = (j / C) * Math.PI * 2;
      const k = 0.5 + 0.5 * Math.cos(phi); // 1 at trailing edge, 0 at leading edge
      const t = foil(k) * st.thick * Math.sign(Math.sin(phi) || 1) * (j === 0 || j === C ? 0 : 1);
      v.set(st.le + k * st.chord, t, (s * FLIPPER_LENGTH - FLIPPER_SINK) * side);
      v.applyQuaternion(rest).add(root);
      part.positions.push(v.x, v.y, v.z);
      part.uvs.push(s * 0.5, (j / C) * ATLAS_BODY_V);
      part.skinIndex.push(bone, ROOT_BONE, tipBone, 0);
      part.skinWeight.push((1 - trunk) * (1 - tip), trunk, (1 - trunk) * tip, 0);
    }
    if (i === S) part.seams.push([start, start + C]);
  }
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < C; j++) {
      const a = base + i * (C + 1) + j;
      const b = a + C + 1;
      if (side === 1) part.indices.push(a, a + 1, b, b, a + 1, b + 1);
      else part.indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
}

export interface FlukeStation { le: number; chord: number; thick: number }

/** Fluke planform at |z| / half-span a: swept leading edge, nearly straight trailing edge with a small notch, pointed tips. */
export function flukeStation(a: number): FlukeStation {
  const x = clamp(a, 0, 1);
  const le = 0.001 * L + 0.0585 * L * x ** 1.75;
  const lobe = lerp(FLUKE_NOTCH_CHORD, FLUKE_LOBE_CHORD, smoothstep(0, 0.12, x));
  const chord = lobe * Math.max(0, 1 - x ** 2.3) ** 0.55 + 0.0015 * L;
  return { le, chord, thick: 0.011 * L * (1 - x) ** 1.3 + 0.001 * L };
}

function buildFluke(spec: DetailSpec, part: Part): void {
  const S = spec.flukeSpan;
  const C = spec.flukeLoop;
  const base = part.positions.length / 3;
  const y0 = spineY(TAIL_X);
  for (let i = 0; i <= S; i++) {
    // Cosine spacing packs stations at the tips and the notch.
    const zf = -Math.cos((i / S) * Math.PI);
    const a = Math.abs(zf);
    const st = flukeStation(a);
    const start = part.positions.length / 3;
    for (let j = 0; j <= C; j++) {
      const phi = (j / C) * Math.PI * 2;
      const k = 0.5 + 0.5 * Math.cos(phi);
      const t = foil(k) * st.thick * Math.sign(Math.sin(phi) || 1) * (j === 0 || j === C ? 0 : 1);
      const x = st.le + k * st.chord - 0.005 * L;
      part.positions.push(TAIL_X + x, y0 + t, zf * FLUKE_HALF_SPAN);
      part.uvs.push(0.5 + 0.25 * (zf + 1), (j / C) * ATLAS_BODY_V);
      // Trailing edges and swept-back tips ride the flex bone; the root stays on the peduncle.
      const flex = smoothstep(0.02 * L, 0.11 * L, x);
      part.skinIndex.push(FLUKE_BONE, FLUKE_FLEX, 0, 0);
      part.skinWeight.push(1 - flex, flex, 0, 0);
    }
    if (i === 0 || i === S) part.seams.push([start, start + C]);
  }
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < C; j++) {
      const a = base + i * (C + 1) + j;
      const b = a + C + 1;
      part.indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
}

function toGeometry(part: Part): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(part.positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(part.uvs, 2));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(part.skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(part.skinWeight, 4));
  geo.setIndex(part.indices);
  geo.computeVertexNormals();
  const n = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (const [a, b] of part.seams) {
    const x = n.getX(a) + n.getX(b);
    const y = n.getY(a) + n.getY(b);
    const z = n.getZ(a) + n.getZ(b);
    const len = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / len, y / len, z / len);
    n.setXYZ(b, x / len, y / len, z / len);
  }
  return geo;
}

export interface WhaleGeometryInfo {
  geometry: THREE.BufferGeometry;
  /** Vertex ranges per part, for tests and debugging. */
  ranges: Record<'body' | 'flipperL' | 'flipperR' | 'fluke', [number, number]>;
}

/** One skinned mesh: body, both flippers and the flukes share a single draw call. */
export function buildWhaleGeometry(detail: WhaleDetail): WhaleGeometryInfo {
  const spec = WHALE_DETAIL[detail];
  const parts = {
    body: newPart(),
    flipperL: newPart(),
    flipperR: newPart(),
    fluke: newPart(),
  };
  buildBody(spec, parts.body);
  buildFlipper(spec, 1, FLIPPER_L, FLIPPER_TIP_L, parts.flipperL);
  buildFlipper(spec, -1, FLIPPER_R, FLIPPER_TIP_R, parts.flipperR);
  buildFluke(spec, parts.fluke);

  const geos = (Object.keys(parts) as (keyof typeof parts)[]).map((key) => toGeometry(parts[key]));
  const ranges = {} as WhaleGeometryInfo['ranges'];
  let offset = 0;
  const keys = Object.keys(parts) as (keyof typeof parts)[];
  keys.forEach((key, i) => {
    const count = item(geos, i).getAttribute('position').count;
    ranges[key] = [offset, offset + count];
    offset += count;
  });
  // three's types promise a geometry; it returns null when the parts' attributes differ.
  const merged = mergeGeometries(geos) as THREE.BufferGeometry | null;
  if (!merged) throw new Error('whale parts do not share attributes');
  for (const g of geos) g.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return { geometry: merged, ranges };
}

/** Bones in bind pose. Callers parent `bones[ROOT_BONE]` under the posed body. */
export function createWhaleBones(): THREE.Bone[] {
  const bones: THREE.Bone[] = [];
  const world: THREE.Vector3[] = [];
  for (const spec of SPINE) {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    bones.push(bone);
    world.push(new THREE.Vector3(spec.x, spineY(spec.x), 0));
  }
  SPINE.forEach((spec, i) => {
    const bone = item(bones, i);
    if (spec.parent >= 0) {
      item(bones, spec.parent).add(bone);
      bone.position.copy(item(world, i)).sub(item(world, spec.parent));
    } else {
      bone.position.copy(item(world, i));
    }
  });
  for (const side of [1, -1] as const) {
    const bone = new THREE.Bone();
    bone.name = side === 1 ? 'FlipperL' : 'FlipperR';
    bone.position.copy(flipperRoot(side)).sub(item(world, ROOT_BONE));
    flipperQuaternion(side, FLIPPER_DROOP, FLIPPER_SWEEP, 0, bone.quaternion);
    item(bones, ROOT_BONE).add(bone);
    bones.push(bone);
  }
  const flex = new THREE.Bone();
  flex.name = 'FlukeFlex';
  flex.position.set(FLUKE_FLEX_X, 0, 0);
  item(bones, FLUKE_BONE).add(flex);
  bones.push(flex);
  for (const side of [1, -1] as const) {
    // In the flipper's own frame the span runs along ±Z from the root (see buildFlipper).
    const tip = new THREE.Bone();
    tip.name = side === 1 ? 'FlipperTipL' : 'FlipperTipR';
    tip.position.set(0, 0, side * (FLIPPER_TIP_S * FLIPPER_LENGTH - FLIPPER_SINK));
    item(bones, side === 1 ? FLIPPER_L : FLIPPER_R).add(tip);
    bones.push(tip);
  }
  return bones;
}
