import { test, expect } from 'vitest';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  BONE_COUNT,
  FLIPPER_LENGTH,
  HEAD_X,
  TAIL_X,
  spineY,
  FLUKE_BONE,
  FLUKE_HALF_SPAN,
  ROOT_BONE,
  SPLASHGUARD_U,
  WHALE_DETAIL,
  WHALE_LENGTH,
  WHALE_LOD,
  buildWhaleGeometry,
  createWhaleBones,
  flukeStation,
  sampleProfile,
  type WhaleDetail,
} from '../src/whale-model.js';
import {
  BREACH_APEX,
  BREACH_EXIT,
  BREACH_LAND,
  BREACH_SPLASH,
  GRAVITY,
  PHASE_LEN,
  PHASE_ORDER,
  POSE_KEYS,
  breachHeight,
  spineAngles,
  whaleOrientation,
  whalePose,
} from '../src/whale-motion.js';
import { whaleForward } from '../src/whale-course.js';
import { item } from '../src/item.js';

const DETAILS: WhaleDetail[] = ['high', 'medium', 'low'];

test('whale geometry is finite, closed-ish and skinned at every detail level', () => {
  let previous = Infinity;
  for (const detail of DETAILS) {
    const { geometry, ranges } = buildWhaleGeometry(detail);
    const pos = geometry.getAttribute('position');
    const nrm = geometry.getAttribute('normal');
    const idx = geometry.getAttribute('skinIndex');
    const wgt = geometry.getAttribute('skinWeight');
    const index = geometry.getIndex();
    assert.ok(index);
    const tris = index.count / 3;
    assert.ok(tris < previous, `${detail} must be lighter than the level above`);
    previous = tris;
    for (let i = 0; i < pos.count; i++) {
      assert.ok(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i)), `${detail} vertex ${String(i)}`);
      assert.ok(Math.abs(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) - 1) < 1e-3, `${detail} normal ${String(i)}`);
      const sum = wgt.getX(i) + wgt.getY(i) + wgt.getZ(i) + wgt.getW(i);
      assert.ok(Math.abs(sum - 1) < 1e-5, `${detail} skin weights sum to 1`);
      for (const k of [idx.getX(i), idx.getY(i), idx.getZ(i), idx.getW(i)]) assert.ok(k >= 0 && k < BONE_COUNT);
    }
    // Body normals point away from the spine.
    let outward = 0;
    const [b0, b1] = ranges.body;
    for (let i = b0; i < b1; i++) {
      const p = sampleProfile(THREE.MathUtils.clamp((pos.getX(i) + 6) / 10.6, 0, 1));
      if ((pos.getY(i) - p.mid) * nrm.getY(i) + pos.getZ(i) * nrm.getZ(i) > 0) outward++;
    }
    assert.ok(outward / (b1 - b0) > 0.97, `${detail} body normals face out (${String(outward / (b1 - b0))})`);

    const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
    const size = box.getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.x - WHALE_LENGTH) < 0.3, `${detail} length ${String(size.x)}`);
    // The flukes are the widest part; a blue whale's flippers are short.
    assert.ok(size.z >= FLUKE_HALF_SPAN * 2 - 1e-6 && size.z < 0.32 * WHALE_LENGTH, `${detail} span ${String(size.z)}`);
  }
  assert.ok(WHALE_DETAIL.high.rings * WHALE_DETAIL.high.radial > 6000, 'close-ups keep a smooth silhouette');
});

test('every body triangle faces outward, including the rostrum and tail caps', () => {
  // The material culls back faces, so an inward triangle shows as a hole.
  for (const detail of Object.keys(WHALE_DETAIL) as WhaleDetail[]) {
    const { geometry, ranges } = buildWhaleGeometry(detail);
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    assert.ok(index);
    const [start, end] = ranges.body;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    const inside = new THREE.Vector3();
    let inward = 0;
    let headInward = 0;
    for (let i = 0; i < index.count; i += 3) {
      const ia = index.getX(i);
      if (ia < start || ia >= end) continue;
      a.fromBufferAttribute(pos, ia);
      b.fromBufferAttribute(pos, index.getX(i + 1));
      c.fromBufferAttribute(pos, index.getX(i + 2));
      normal.subVectors(b, a).cross(c.clone().sub(a));
      if (normal.lengthSq() < 1e-14) continue;
      centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      const x = THREE.MathUtils.clamp(centroid.x, HEAD_X + 0.3, TAIL_X - 0.3);
      inside.set(x, spineY(x), 0);
      if (normal.dot(centroid.clone().sub(inside)) < 0) {
        inward++;
        if (centroid.x < HEAD_X + 0.05) headInward++;
      }
    }
    assert.equal(headInward, 0, `${detail}: rostrum cap triangles face inward`);
    assert.equal(inward, 0, `${detail}: ${String(inward)} body triangles face inward`);
    geometry.dispose();
  }
});

test('whale proportions read as a blue whale', () => {
  // Adult blue whales are 24 to 27 m.
  expect(WHALE_LENGTH).toBeGreaterThanOrEqual(24);
  expect(WHALE_LENGTH).toBeLessThanOrEqual(27);
  const { geometry, ranges } = buildWhaleGeometry('high');
  const pos = geometry.getAttribute('position');
  // Short, slender flippers: about an eighth of the length.
  assert.ok(FLIPPER_LENGTH / WHALE_LENGTH > 0.1 && FLIPPER_LENGTH / WHALE_LENGTH < 0.15);
  const [f0, f1] = ranges.flipperL;
  let reach = 0;
  for (let i = f0; i < f1; i++) for (let j = f0; j < f1; j += 7) {
    reach = Math.max(reach, Math.hypot(pos.getX(i) - pos.getX(j), pos.getY(i) - pos.getY(j), pos.getZ(i) - pos.getZ(j)));
  }
  assert.ok(reach > 0.1 * WHALE_LENGTH && reach < 0.15 * WHALE_LENGTH, `flipper reach ${String(reach)}`);
  // Broad flukes, a quarter of the length or so, with a small notch and pointed tips.
  assert.ok(FLUKE_HALF_SPAN * 2 > 0.22 * WHALE_LENGTH && FLUKE_HALF_SPAN * 2 < 0.3 * WHALE_LENGTH);
  assert.ok(flukeStation(0).chord < flukeStation(0.15).chord - 0.02 * WHALE_LENGTH, 'notched trailing edge');
  assert.ok(flukeStation(1).chord < 0.003 * WHALE_LENGTH, 'pointed fluke tips');
  // Slender body: about an eighth as deep as it is long.
  let depth = 0;
  for (let u = 0; u <= 1; u += 0.01) depth = Math.max(depth, sampleProfile(u).top - sampleProfile(u).bot);
  assert.ok(depth / WHALE_LENGTH > 0.11 && depth / WHALE_LENGTH < 0.135, `body depth ${String(depth)}`);
  // Broad, flat head: wider than it is deep.
  const head = sampleProfile(0.06);
  assert.ok(head.width * 2 > head.top - head.bot, 'flat U-shaped head');
  // A raised splashguard in front of the blowholes.
  assert.ok(sampleProfile(SPLASHGUARD_U).guard > 0.004 * WHALE_LENGTH, 'splashguard');
  // Laterally compressed tail stock.
  const stock = sampleProfile(0.85);
  assert.ok(stock.width * 2 < (stock.top - stock.bot) * 0.9, 'laterally compressed tail stock');
  // A small dorsal fin about three quarters of the way back.
  let fin = 0;
  let finU = 0;
  for (let u = 0.6; u <= 0.9; u += 0.002) if (sampleProfile(u).fin > fin) [fin, finU] = [sampleProfile(u).fin, u];
  assert.ok(fin > 0.008 * WHALE_LENGTH && fin < 0.02 * WHALE_LENGTH, `small dorsal fin ${String(fin)}`);
  assert.ok(finU > 0.72 && finU < 0.82, `fin set far back (${String(finU)})`);
});

test('whale geometry is deterministic and LOD tables are ordered', () => {
  const a = buildWhaleGeometry('medium').geometry.getAttribute('position').array;
  const b = buildWhaleGeometry('medium').geometry.getAttribute('position').array;
  assert.deepEqual(Array.from(a), Array.from(b));
  for (const tier of ['high', 'medium', 'low'] as const) {
    const levels = WHALE_LOD[tier];
    assert.equal(item(levels, 0).distance, 0);
    for (let i = 1; i < levels.length; i++) {
      assert.ok(item(levels, i).distance > item(levels, i - 1).distance);
      assert.ok(WHALE_DETAIL[item(levels, i).detail].rings < WHALE_DETAIL[item(levels, i - 1).detail].rings);
    }
  }
  assert.ok(!WHALE_LOD.low.some((l) => l.detail === 'high'), 'phones never build the densest mesh');
});

test('whale phases join without jumps across the whole cycle', () => {
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    const from = item(PHASE_ORDER, i);
    const to = item(PHASE_ORDER, (i + 1) % PHASE_ORDER.length);
    const end = whalePose(from, 1);
    const start = whalePose(to, 0);
    for (const key of POSE_KEYS) {
      assert.ok(Math.abs(end[key] - start[key]) < 1e-6, `${from}→${to} ${key}: ${String(end[key])} vs ${String(start[key])}`);
    }
  }
  // And within each phase, no single step jumps.
  for (const phase of Object.keys(PHASE_LEN) as (keyof typeof PHASE_LEN)[]) {
    const dt = 1 / 60 / PHASE_LEN[phase];
    let prev = whalePose(phase, 0);
    for (let t = dt; t <= 1; t += dt) {
      const pose = whalePose(phase, t);
      assert.ok(Math.abs(pose.y - prev.y) < 0.25, `${phase} y step at ${String(t)}`);
      assert.ok(Math.abs(pose.pitch - prev.pitch) < 0.05, `${phase} pitch step at ${String(t)}`);
      assert.ok(Math.abs(pose.roll - prev.roll) < 0.05, `${phase} roll step at ${String(t)}`);
      prev = pose;
    }
  }
});

test('breach follows a ballistic arc with nose-up exit and a rolled re-entry', () => {
  const T = PHASE_LEN.breach;
  const h = 0.02 / T;
  for (let t = BREACH_EXIT + h; t < BREACH_LAND - h; t += 0.05) {
    const accel = (breachHeight(t + h) - 2 * breachHeight(t) + breachHeight(t - h)) / (0.02 * 0.02);
    assert.ok(Math.abs(accel + GRAVITY) < 0.05, `free fall at ${String(t)}: ${String(accel)}`);
  }
  assert.ok(breachHeight(BREACH_APEX) > 3.5, 'body clears the water');
  assert.ok(whalePose('breach', BREACH_EXIT).pitch > 1, 'leaves the water nose-up');
  assert.ok(BREACH_SPLASH > BREACH_APEX && BREACH_SPLASH < BREACH_LAND, 'splash fires as the falling body meets the water');
  assert.ok(Math.abs(whalePose('breach', BREACH_SPLASH).roll) > 1.4, 'on its side at re-entry');
  assert.ok(whalePose('breach', BREACH_SPLASH).pitch < -0.4, 'crashes in nose-down, not flat');
  // Under within half a second of impact: no floating on the surface.
  assert.ok(breachHeight(BREACH_SPLASH + 0.5 / T) < -2.5, `submerges after impact (${String(breachHeight(BREACH_SPLASH + 0.5 / T))})`);
  let travel = 0;
  for (let t = 0; t < 1; t += 0.001) travel += whalePose('breach', t).surge * 0.001 * T;
  assert.ok(travel > 3 && travel < 7, `breach carries the whale forward (${String(travel)} m extra)`);
  assert.ok(whalePose('breach', (BREACH_EXIT + BREACH_LAND) / 2).flipLift < -0.8, 'flippers spread in the air');
});

/** Highest the fluke root rises over a phase (stroke left out: the arch and pitch do the lifting). */
function flukePeak(phase: 'dive' | 'roll'): number {
  const holder = new THREE.Object3D();
  const bones = createWhaleBones();
  holder.add(item(bones, ROOT_BONE));
  let peak = -Infinity;
  for (let t = 0; t <= 1; t += 0.02) {
    const pose = whalePose(phase, t);
    holder.position.set(0, pose.y, 0);
    whaleOrientation(0.7, pose.pitch, 0, holder.quaternion);
    const angles = spineAngles(0, 0, pose.arch);
    item(bones, 1).rotation.z = angles.head[0] ?? 0;
    item(bones, 0).rotation.z = angles.head[1] ?? 0;
    for (let i = 0; i < 5; i++) item(bones, 3 + i).rotation.z = angles.tail[i] ?? 0;
    holder.updateMatrixWorld(true);
    peak = Math.max(peak, item(bones, FLUKE_BONE).getWorldPosition(new THREE.Vector3()).y);
  }
  return peak;
}

test('the fluke-up dive lifts the flukes clear of the water; a roll between blows keeps them under', () => {
  assert.ok(flukePeak('dive') > 0.6, `fluke root rises above the surface (${String(flukePeak('dive'))})`);
  assert.ok(flukePeak('roll') < -0.25, `fluke root stays under in a roll (${String(flukePeak('roll'))})`);
});

test('whale faces its direction of travel and the stroke wave runs head to tail', () => {
  for (const heading of [0, 0.8, 2.5, -1.9]) {
    const head = new THREE.Vector3(-1, 0, 0).applyQuaternion(whaleOrientation(heading, 0, 0));
    const fwd = whaleForward(heading);
    assert.ok(Math.abs(head.x - fwd.x) < 1e-6 && Math.abs(head.z - fwd.z) < 1e-6 && Math.abs(head.y) < 1e-6);
    const up = new THREE.Vector3(-1, 0, 0).applyQuaternion(whaleOrientation(heading, 0.5, 0.3));
    assert.ok(up.y > 0.47, 'positive pitch lifts the nose');
  }
  // Each tail bone peaks later than the one before it.
  const peakPhase = (bone: number) => {
    let best = 0;
    let bestV = -Infinity;
    for (let p = 0; p < Math.PI * 2; p += 0.01) {
      const v = spineAngles(p, 1, 0).tail[bone] ?? 0;
      if (v > bestV) {
        bestV = v;
        best = p;
      }
    }
    return best;
  };
  for (let i = 1; i < 5; i++) {
    const lag = (peakPhase(i) - peakPhase(i - 1) + Math.PI * 2) % (Math.PI * 2);
    assert.ok(lag > 0.3 && lag < 1.2, `bone ${String(i)} lags (${String(lag)})`);
  }
});
