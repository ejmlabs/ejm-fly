import * as THREE from 'three';
import { smoothstep } from './math.js';
import { item } from './item.js';
import { drawAsAuthored } from './tone.js';

/** Where a wake is made: world metres, heading as the whale's (forward = (−cos h, sin h)), height of the body and speed in m/s. */
export interface WakeSource { x: number; y: number; z: number; heading: number; speed: number }

export interface WakeOptions {
  /** Points of the trail, one per `interval` seconds. */
  points?: number;
  interval?: number;
  /** Metres from the source back to where the trail starts (the stern). */
  stern?: number;
  /** Metres from the source forward to the bow. */
  bow?: number;
  /** Half-width of the trail at its start and the growth per second of age. */
  width?: number;
  spread?: number;
  /** Wake strength follows speed over this range (m/s). */
  speeds?: readonly [number, number];
  /** Body heights (m): no wake below the first, full wake above the second. */
  depths?: readonly [number, number];
  /** Height of the sea at world (x, z); the foam lies on it. Flat water when not given. */
  surface?: (x: number, z: number) => number;
}

export interface Wake {
  /** A trail ribbon and a bow wave: one draw, added to the world group (world coordinates, floating origin applied by the parent). */
  group: THREE.Group;
  update: (source: WakeSource, dt: number) => void;
  /** Daylight, 0 to 1: the foam darkens with the sea at dusk and night. */
  setLight: (level: number) => void;
  /** Metres of trail drawn at more than `alpha` opacity right now (debug and tests). */
  length: (alpha?: number) => number;
  /** Draws made last frame. */
  draws: () => number;
  dispose: () => void;
}

const COLOR = new THREE.Color(0xeaf3f6);
/** Foam rides just above the water. */
const LIFT = 0.04;
/** Seconds of age at which the trail has faded out. */
const LIFE = 4.5;
const PEAK = 0.24;
/** Columns across the trail and how strong each is: a soft ridge down the middle that melts into the sea at both edges. */
const ACROSS = [-1, -0.5, 0, 0.5, 1] as const;
const ACROSS_ALPHA = [0, 0.4, 1, 0.4, 0] as const;
const COLUMNS = ACROSS.length;

/** Strength of the wake of a body: none when slow or under water, full when fast and at the surface. */
export function wakeStrength(speed: number, y: number, speeds: readonly [number, number] = [3, 14], depths: readonly [number, number] = [-2.6, -0.9]): number {
  return smoothstep(speeds[0], speeds[1], speed) * smoothstep(depths[0], depths[1], y);
}

/**
 * A foam trail and a bow wave for something that swims or sails: soft ribbons on the water, one vertex colour
 * alpha per point, no texture. The trail's points are kept relative to the source so far coordinates stay exact.
 */
export function createWake(options: WakeOptions = {}): Wake {
  const count = options.points ?? 64;
  const interval = options.interval ?? 0.1;
  const stern = options.stern ?? 5;
  const bow = options.bow ?? 6;
  const width = options.width ?? 0.8;
  const spread = options.spread ?? 0.45;
  const speeds = options.speeds ?? [3, 14];
  const depths = options.depths ?? [-2.6, -0.9];
  const surface = options.surface ?? (() => 0);

  // Trail points, newest first in ring order: world x, z, heading, strength, age.
  const px = new Float64Array(count);
  const pz = new Float64Array(count);
  const ph = new Float64Array(count);
  const ps = new Float64Array(count);
  const pa = new Float64Array(count);
  const pn = new Float64Array(count);
  let serial = 0;
  let head = 0;
  let filled = 0;
  let since = interval;
  let strength = 0;

  const ARM = 5;
  const trailVerts = count * COLUMNS;
  const bowVerts = ARM * 2 * 2;
  // One buffer for the trail and the bow wave, so the whole wake is one draw.
  const positions = new Float32Array((trailVerts + bowVerts) * 3);
  const colors = new Float32Array((trailVerts + bowVerts) * 4);
  const trailPositions = positions.subarray(0, trailVerts * 3);
  const trailColors = colors.subarray(0, trailVerts * 4);
  const bowBase = positions.subarray(trailVerts * 3);
  const bowColors = colors.subarray(trailVerts * 4);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage));
  const trailIndex: number[] = [];
  for (let i = 0; i + 1 < count; i++) {
    for (let c = 0; c + 1 < COLUMNS; c++) {
      const a = i * COLUMNS + c;
      const b = a + COLUMNS;
      trailIndex.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  // Bow wave: a flat chevron whose two arms sweep back from the nose.
  // Two arms (port and starboard), each a strip of ARM stations of two vertices, after the trail's vertices.
  for (let arm = 0; arm < 2; arm++) {
    for (let i = 0; i + 1 < ARM; i++) {
      const a = trailVerts + arm * ARM * 2 + i * 2;
      trailIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geometry.setIndex(trailIndex);

  const material = drawAsAuthored(new THREE.MeshBasicMaterial({
    color: COLOR,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // White water stays white, as the whale's own spray does: authored as it should look on screen.
    fog: false,
  }));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.visible = false;
  const group = new THREE.Group();
  group.name = 'wake';
  group.add(mesh);

  /** Opacity of a point of this age and strength. */
  const fade = (age: number, s: number): number => PEAK * s * (1 - smoothstep(0, LIFE, age)) ** 1.5 * smoothstep(0, 0.4, age);

  function writeTrail(source: WakeSource): void {
    // The mesh sits on the source, so vertices are small offsets.
    mesh.position.set(source.x, LIFT, source.z);
    let written = 0;
    for (let k = 0; k < filled; k++) {
      const i = (head - 1 - k + count * 2) % count;
      const age = pa[i] ?? 0;
      // Churned water is patchy: each point is a little stronger or weaker than its neighbours.
      // Broken foam: patches along the trail, and ragged across it.
      const a = fade(age, ps[i] ?? 0) * (0.3 + 0.7 * Math.abs(Math.sin((pn[i] ?? 0) * 0.8) * Math.cos((pn[i] ?? 0) * 0.31 + 1)));
      const half = width + spread * age;
      // Across the heading: the whale's right is (−fz, fx) with forward (−cos h, sin h).
      const fx = -Math.cos(ph[i] ?? 0);
      const fz = Math.sin(ph[i] ?? 0);
      const cx = (px[i] ?? 0) - source.x;
      const cz = (pz[i] ?? 0) - source.z;
      for (let c = 0; c < COLUMNS; c++) {
        const o = (written * COLUMNS + c) * 3;
        const side = item(ACROSS, c) * half;
        trailPositions[o] = cx - fz * side;
        trailPositions[o + 1] = surface(source.x + trailPositions[o], source.z + cz + fx * side);
        trailPositions[o + 2] = cz + fx * side;
        const q = (written * COLUMNS + c) * 4;
        trailColors[q] = 1;
        trailColors[q + 1] = 1;
        trailColors[q + 2] = 1;
        trailColors[q + 3] = a * item(ACROSS_ALPHA, c) * (0.55 + 0.45 * Math.sin((pn[i] ?? 0) * 2.3 + c * 1.7));
      }
      written++;
    }
    // Points not in use draw nothing.
    trailPositions.fill(0, written * COLUMNS * 3);
    trailColors.fill(0, written * COLUMNS * 4);
  }

  function writeBow(source: WakeSource, s: number): void {
    const fx = -Math.cos(source.heading);
    const fz = Math.sin(source.heading);
    // Longer and wider the faster it goes.
    const run = 2.2 + 5 * s;
    const open = 0.28 + 0.12 * s;
    for (let arm = 0; arm < 2; arm++) {
      const side = arm === 0 ? 1 : -1;
      for (let i = 0; i < ARM; i++) {
        const u = i / (ARM - 1);
        // Back along the heading and out to the side; each station is a thin strip of growing width.
        const back = u * run;
        const out = side * (back * open + 0.1);
        const thick = 0.18 + 0.5 * u * s;
        const o = (arm * ARM + i) * 6;
        for (let edge = 0; edge < 2; edge++) {
          const w = out + side * (edge === 0 ? -thick : thick) * 0.5;
          // Right of the heading is (−fz, fx).
          bowBase[o + edge * 3] = fx * bow - fx * back + -fz * w;
          bowBase[o + edge * 3 + 2] = fz * bow - fz * back + fx * w;
          bowBase[o + edge * 3 + 1] = surface(source.x + (bowBase[o + edge * 3] ?? 0), source.z + (bowBase[o + edge * 3 + 2] ?? 0));
        }
        const a = PEAK * 1.3 * s * (1 - u) ** 1.2;
        const c = (arm * ARM + i) * 8;
        for (let edge = 0; edge < 2; edge++) {
          bowColors[c + edge * 4] = 1;
          bowColors[c + edge * 4 + 1] = 1;
          bowColors[c + edge * 4 + 2] = 1;
          bowColors[c + edge * 4 + 3] = a * (edge === 0 ? 1 : 0.35);
        }
      }
    }
  }

  let drawn = 0;
  return {
    group,
    update(source, dt) {
      strength = wakeStrength(source.speed, source.y, speeds, depths);
      // Everything drawn is an offset from here, trail and bow wave alike.
      mesh.position.set(source.x, LIFT, source.z);
      const fx = -Math.cos(source.heading);
      const fz = Math.sin(source.heading);
      for (let k = 0; k < filled; k++) {
        const at = (head - 1 - k + count * 2) % count;
        pa[at] = (pa[at] ?? 0) + dt;
      }
      since += dt;
      // A jump (a recentre of the debug travel) leaves the old trail behind: start again.
      if (filled > 0) {
        const last = (head - 1 + count) % count;
        if (Math.hypot(source.x - (px[last] ?? 0), source.z - (pz[last] ?? 0)) > 120) filled = 0;
      }
      if (since >= interval && strength > 0.02) {
        since = 0;
        px[head] = source.x - fx * stern;
        pz[head] = source.z - fz * stern;
        ph[head] = source.heading;
        ps[head] = strength;
        pa[head] = 0;
        pn[head] = serial++ * 1.9;
        head = (head + 1) % count;
        filled = Math.min(count, filled + 1);
      }
      // Anything that has faded out is no longer drawn.
      let live = 0;
      for (let k = 0; k < filled; k++) {
        if ((pa[(head - 1 - k + count * 2) % count] ?? 0) < LIFE) live++;
        else break;
      }
      filled = live;
      const showTrail = filled > 1;
      const showBow = strength > 0.02;
      mesh.visible = showTrail || showBow;
      if (showTrail) writeTrail(source);
      else {
        trailPositions.fill(0);
        trailColors.fill(0);
      }
      if (showBow) writeBow(source, strength);
      else bowColors.fill(0);
      item(geometry.attributes, 'position').needsUpdate = true;
      item(geometry.attributes, 'color').needsUpdate = true;
      drawn = mesh.visible ? 1 : 0;
    },
    length(alpha = 0.1) {
      let metres = 0;
      for (let k = 1; k < filled; k++) {
        const i = (head - 1 - k + count * 2) % count;
        const j = (head - k + count * 2) % count;
        // The newest points are still fading in; only the fade-out ends the count.
        if ((pa[i] ?? 0) > 0.4 && fade(pa[i] ?? 0, ps[i] ?? 0) < alpha) break;
        metres += Math.hypot((px[i] ?? 0) - (px[j] ?? 0), (pz[i] ?? 0) - (pz[j] ?? 0));
      }
      return metres;
    },
    setLight(level) {
      // Foam is never brighter than the sea it lies on: it dims with the light, and fades with it too.
      material.color.setScalar(0.06 + 0.7 * level);
      material.opacity = 0.35 + 0.65 * level;
    },
    draws: () => drawn,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
