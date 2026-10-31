import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSpring, springStep, springStepAngle } from '../src/spring.js';
import { DIVE_BELOW, DIVE_DWELL, EYE_CLEARANCE, FollowCamera, MIN_DISTANCE, PEEK_IDLE, RISE_ABOVE, WHALE_HALF } from '../src/camera.js';
import { WATER_LEVEL, type FollowTarget } from '../src/seams.js';
import { DEPTH_SCALE } from '../src/whale-size.js';
import { item, last } from '../src/item.js';

const fwd = (h: number) => ({ x: -Math.cos(h), z: Math.sin(h) });

function rig(portrait = false) {
  const camera = new THREE.PerspectiveCamera(48, 1, 0.5, 12000);
  return { camera, rig: new FollowCamera(camera, { portrait }) };
}

/** Camera view yaw (direction of eye → lookAt) in whale-heading convention. */
function viewYaw(r: FollowCamera): number {
  const p = r.camera.position;
  return Math.atan2(r.lookAt.z - p.z, -(r.lookAt.x - p.x));
}

test('spring from rest never overshoots and converges', () => {
  const s = createSpring(0);
  let prev = 0;
  for (let i = 0; i < 600; i++) {
    const x = springStep(s, 10, 2, 1 / 60);
    assert.ok(x <= 10 + 1e-12, `overshoot ${String(x)}`);
    assert.ok(x >= prev - 1e-12, 'not monotonic');
    prev = x;
  }
  assert.ok(Math.abs(prev - 10) < 1e-3);
});

test('spring is frame-rate independent', () => {
  const a = createSpring(-3);
  const b = createSpring(-3);
  a.v = b.v = 4;
  for (let i = 0; i < 60; i++) springStep(a, 7, 1.7, 1 / 30);
  for (let i = 0; i < 120; i++) springStep(b, 7, 1.7, 1 / 60);
  assert.ok(Math.abs(a.x - b.x) < 1e-6, `${String(a.x)} vs ${String(b.x)}`);
  assert.ok(Math.abs(a.v - b.v) < 1e-6);
});

test('angle spring takes the short way across ±π', () => {
  const s = createSpring(Math.PI - 0.1);
  let prev = s.x;
  for (let i = 0; i < 300; i++) {
    const x = springStepAngle(s, -Math.PI + 0.1, 3, 1 / 60);
    assert.ok(x >= prev - 1e-12, 'turned the long way');
    prev = x;
  }
  assert.ok(Math.abs(prev - (Math.PI + 0.1)) < 1e-3);
});

test('rig settles behind a target moving straight, without oscillation', () => {
  const { rig: r, camera } = rig();
  const h = 0.7;
  const f = fwd(h);
  const t: FollowTarget = { x: 0, y: -1.2, z: 0, heading: h };
  const along: number[] = [];
  for (let i = 0; i < 60 * 20; i++) {
    t.x += f.x * 2 / 60;
    t.z += f.z * 2 / 60;
    r.setTarget(t);
    r.update(1 / 60, i / 60);
    along.push((camera.position.x - t.x) * f.x + (camera.position.z - t.z) * f.z);
  }
  const dx = camera.position.x - t.x;
  const dz = camera.position.z - t.z;
  const len = Math.hypot(dx, dz);
  assert.ok((-dx * f.x - dz * f.z) / len > 0.99, 'not behind the whale');
  assert.ok(len > 14 && len < 40, `distance ${String(len)}`);
  assert.ok(camera.position.y > 3, 'eye too low above water');
  // Trailing distance grows monotonically to the steady lag: no ringing.
  for (let i = 1; i < along.length; i++) assert.ok((along[i] ?? 0) <= (along[i - 1] ?? 0) + 1e-9, `oscillation at ${String(i)}`);
});

test('a 90° heading change turns the view monotonically', () => {
  const { rig: r } = rig();
  const t: FollowTarget = { x: 5, y: -1.2, z: -3, heading: 0.2 };
  r.setTarget(t);
  r.update(1 / 60, 0);
  t.heading = 0.2 + Math.PI / 2;
  r.setTarget(t);
  let prev = viewYaw(r);
  for (let i = 0; i < 60 * 15; i++) {
    r.update(1 / 60, i / 60);
    const y = viewYaw(r);
    assert.ok(y >= prev - 1e-9, `yaw went back at ${String(i)}`);
    prev = y;
  }
  assert.ok(Math.abs(prev - viewYaw(r)) < 1e-9);
});

test('target noise gives bounded, smooth camera motion', () => {
  const { rig: r, camera } = rig();
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.1;
  const t: FollowTarget = { x: 0, y: -1.2, z: 0, heading: 1 };
  const pos: THREE.Vector3[] = [];
  for (let i = 0; i < 600; i++) {
    r.setTarget({ x: t.x + noise(), y: t.y + noise(), z: t.z + noise(), heading: t.heading + noise() * 0.2 });
    r.update(1 / 60, i / 60);
    pos.push(camera.position.clone());
  }
  for (let i = 120; i < pos.length; i++) {
    assert.ok(item(pos, i).distanceTo(item(pos, i - 1)) < 0.02, `step ${String(i)} too large`);
    const accel = item(pos, i).clone().sub(item(pos, i - 1)).sub(item(pos, i - 1).clone().sub(item(pos, i - 2))).length();
    assert.ok(accel < 0.005, `jerky at ${String(i)}`);
  }
});

test('shift keeps the pose relative to the target', () => {
  const { rig: r, camera } = rig();
  const t: FollowTarget = { x: 10, y: -1.2, z: 20, heading: 2 };
  for (let i = 0; i < 120; i++) {
    t.x += 0.03;
    r.setTarget(t);
    r.update(1 / 60, i / 60);
  }
  const before = camera.position.clone().sub(new THREE.Vector3(t.x, 0, t.z));
  r.shift(512, -256);
  t.x -= 512;
  t.z += 256;
  const after = camera.position.clone().sub(new THREE.Vector3(t.x, 0, t.z));
  assert.ok(before.distanceTo(after) < 1e-9);
  // Keep going and compare with an unshifted run.
  for (let i = 0; i < 60; i++) {
    t.x += 0.03;
    r.setTarget(t);
    r.update(1 / 60, i / 60);
  }
  const ref = rig();
  const rt: FollowTarget = { x: 10, y: -1.2, z: 20, heading: 2 };
  for (let i = 0; i < 180; i++) {
    rt.x += 0.03;
    ref.rig.setTarget(rt);
    ref.rig.update(1 / 60, i / 60);
  }
  const a = camera.position.clone().sub(new THREE.Vector3(t.x, t.y, t.z));
  const b = ref.camera.position.clone().sub(new THREE.Vector3(rt.x, rt.y, rt.z));
  assert.ok(a.distanceTo(b) < 1e-6, `drifted ${String(a.distanceTo(b))}`);
});

test('follows the whale under water and never rests in the surface band', () => {
  const { rig: r, camera } = rig();
  const t: FollowTarget = { x: 0, y: -1.2, z: 0, heading: 0 };
  const settle = (y: number, seconds = 12) => {
    t.y = y;
    for (let i = 0; i < seconds * 60; i++) {
      r.setTarget(t);
      r.update(1 / 60, 0);
    }
  };
  settle(-1);
  assert.ok(camera.position.y > WATER_LEVEL + EYE_CLEARANCE, 'shallow whale: eye should stay above');
  assert.equal(r.mode, 'chase');
  settle(-10);
  assert.ok(camera.position.y < WATER_LEVEL - EYE_CLEARANCE, `deep: eye at ${String(camera.position.y)}`);
  assert.equal(r.mode, 'under');
  // Between the hysteresis thresholds it stays where it is.
  settle((DIVE_BELOW + RISE_ABOVE) / 2);
  assert.equal(r.mode, 'under');
  assert.ok(camera.position.y < WATER_LEVEL - EYE_CLEARANCE);
  // A target whose natural eye height is inside the band is held outside it.
  settle(RISE_ABOVE - 0.4 * DEPTH_SCALE);
  r.look(0, 200); // a peek upward would lift the eye into the band
  for (let i = 0; i < 150; i++) {
    r.update(1 / 60, 0);
    assert.ok(camera.position.y <= WATER_LEVEL - EYE_CLEARANCE + 1e-9, `in band: ${String(camera.position.y)}`);
  }
  settle(-1);
  assert.equal(r.mode, 'chase');
  assert.ok(camera.position.y > WATER_LEVEL + EYE_CLEARANCE);
  settle((DIVE_BELOW + RISE_ABOVE) / 2);
  assert.equal(r.mode, 'chase');
});

test('crossing the surface is brisk', () => {
  const { rig: r, camera } = rig();
  const t: FollowTarget = { x: 0, y: -1.2, z: 0, heading: 0 };
  r.setTarget(t);
  r.update(1 / 60, 0);
  t.y = -4.5;
  let inBand = 0;
  for (let i = 0; i < 60 * 15; i++) {
    r.setTarget(t);
    r.update(1 / 60, 0);
    if (Math.abs(camera.position.y - WATER_LEVEL) < EYE_CLEARANCE) inBand++;
  }
  assert.ok(inBand > 0 && inBand < 30, `${String(inBand)} frames inside the band`);
});

test('a drag peek springs back to the heading after idle', () => {
  const { rig: r } = rig();
  const t: FollowTarget = { x: 0, y: -1.2, z: 0, heading: 1.3 };
  r.setTarget(t);
  r.update(1 / 60, 0);
  const locked = viewYaw(r);
  r.look(-400, 0);
  for (let i = 0; i < 60; i++) r.update(1 / 60, 0);
  const peek = viewYaw(r) - locked;
  assert.ok(peek > 0.4 && peek <= 0.65, `peek ${String(peek)}`);
  for (let i = 0; i < 60 * (PEEK_IDLE + 8); i++) r.update(1 / 60, 0);
  assert.ok(Math.abs(viewYaw(r) - locked) < 0.01, 'did not return');
});

test('reduced motion with dt = 0 freezes the pose', () => {
  const { rig: r, camera } = rig();
  r.setTarget({ x: 3, y: -1.2, z: 4, heading: 0.5 });
  r.update(0, 0, true);
  const p = camera.position.clone();
  r.update(0, 0, true);
  assert.ok(camera.position.distanceTo(p) < 1e-12);
});

// ---- Synthetic journeys: the whale must stay framed in every frame. ----

type Ground = (x: number, z: number) => number;
type Path = (time: number) => { speed: number; heading: number; y: number };

const SCREENS = [
  { name: 'landscape', fov: 48, aspect: 1.6, portrait: false },
  { name: 'portrait', fov: 62, aspect: 0.46, portrait: true },
];

/** Integrate a path (speed along heading) and drive a rig, checking every frame. */
function journey(path: Path, seconds: number, opts: { fps?: number; ground?: Ground; screen?: (typeof SCREENS)[number] } = {}) {
  const fps = opts.fps ?? 60;
  const screen = opts.screen ?? item(SCREENS, 0);
  const camera = new THREE.PerspectiveCamera(screen.fov, screen.aspect, 0.5, 12000);
  const r = new FollowCamera(camera, { portrait: screen.portrait, groundAt: opts.ground });
  const t: FollowTarget = { x: 0, y: 0, z: 0, heading: 0 };
  const frames: { eye: THREE.Vector3; target: FollowTarget; worst: number; gap: number; yaw: number }[] = [];
  const point = new THREE.Vector3();
  const dir = new THREE.Vector3();
  for (let i = 0; i <= seconds * fps; i++) {
    const time = i / fps;
    const p = path(time);
    if (i > 0) {
      t.x += -Math.cos(p.heading) * p.speed / fps;
      t.z += Math.sin(p.heading) * p.speed / fps;
    }
    t.heading = p.heading;
    t.y = p.y;
    r.setTarget(t);
    r.update(i === 0 ? 0 : 1 / fps, time);
    camera.updateMatrixWorld();
    let worst = 0;
    let gap = Infinity;
    for (const k of [-1, 0, 1]) {
      point.set(t.x - Math.cos(t.heading) * WHALE_HALF * k, t.y, t.z + Math.sin(t.heading) * WHALE_HALF * k);
      gap = Math.min(gap, point.distanceTo(camera.position));
      point.project(camera);
      worst = Math.max(worst, point.z > 1 ? Infinity : Math.max(Math.abs(point.x), Math.abs(point.y)));
    }
    camera.getWorldDirection(dir);
    frames.push({ eye: camera.position.clone(), target: { ...t }, worst, gap, yaw: Math.atan2(dir.z, -dir.x) });
  }
  return { frames, rig: r, camera };
}

function assertFramed(frames: ReturnType<typeof journey>['frames'], ground?: Ground, label = '') {
  let inBand = 0;
  frames.forEach((f, i) => {
    assert.ok(f.worst <= 0.9, `${label} frame ${String(i)}: whale at NDC ${f.worst.toFixed(3)}`);
    assert.ok(f.gap >= MIN_DISTANCE - 1e-6, `${label} frame ${String(i)}: ${f.gap.toFixed(2)} m from the whale`);
    inBand = Math.abs(f.eye.y - WATER_LEVEL) < EYE_CLEARANCE ? inBand + 1 : 0;
    assert.ok(inBand < 20, `${label} frame ${String(i)}: resting in the surface band`);
    if (ground && inBand === 0) {
      const clear = f.eye.y - ground(f.eye.x, f.eye.z);
      assert.ok(clear >= 1.5 - 1e-6, `${label} frame ${String(i)}: ${clear.toFixed(2)} m above ground`);
    }
  });
}

const cruise: Path = (s) => ({ speed: 12 + 2.5 * Math.sin(0.7 * s) + 1.5 * Math.sin(1.9 * s + 1), heading: 0.4 + 0.3 * Math.sin(0.15 * s), y: -1.4 });
const stopAndGo: Path = (s) => ({ speed: 7 * Math.max(0, Math.sin(0.5 * s)) ** 2, heading: 0.6 * Math.sin(0.23 * s) + (Math.sin(0.5 * s) < 0 ? 0.4 * s : 0), y: -1.4 });
const circle: Path = (s) => ({ speed: 2, heading: (2 / 15) * s, y: -1.6 });
const dive: Path = (s) => {
  const k = s % 14;
  return { speed: 5, heading: 0.1 * s, y: k < 8 ? -1.4 - 14.6 * Math.sin((Math.PI * k) / 8) ** 2 : -1.4 };
};
const breach: Path = (s) => {
  const k = s % 10;
  // Rise from −6, leave the water at k = 4, peak at 4.2 m, splash down.
  const y = k < 4 ? -6 + 5 * (k / 4) ** 2 : k < 6 ? -1 + 5.2 * (1 - ((k - 5) / 1) ** 2) : -1.4 - 2 * Math.sin(Math.PI * Math.min(1, (k - 6) / 4));
  return { speed: 4, heading: 1.2, y };
};
/** Seabed at −20, a ridge rising to an island off to the side, and a sea mount on the path. */
const ground: Ground = (x, z) => Math.max(-20 + 26 * Math.exp(-((z + 60) ** 2) / 900), -20 + 12 * Math.exp(-((x + 160) ** 2 + (z - 70) ** 2) / 400));

for (const screen of SCREENS) {
  for (const [name, path, seconds] of [
    ['fast noisy cruise', cruise, 40],
    ['stop and go', stopAndGo, 40],
    ['15 m circle', circle, 50],
    ['dive to −16 m', dive, 42],
    ['breach', breach, 30],
  ] as const) {
    test(`${screen.name}: ${name} keeps the whale framed`, () => {
      assertFramed(journey(path, seconds, { screen, ground }).frames, ground, name);
      assertFramed(journey(path, seconds, { screen }).frames, undefined, name);
    });
  }
}

test('the camera follows a dive under and comes back up', () => {
  const { frames } = journey(dive, 14);
  const deepest = Math.min(...frames.map((f) => f.eye.y));
  // The trailing eye sits above a big whale's back, so it goes well under but not as deep as the whale.
  assert.ok(deepest < -5, `eye only reached ${String(deepest)}`);
  assert.ok(last(frames).eye.y > WATER_LEVEL + EYE_CLEARANCE, 'did not resurface');
});

test('a short shallow dip does not take the camera under', () => {
  const dip: Path = (s) => ({ speed: 4, heading: 0, y: s > 2 && s < 2 + DIVE_DWELL * 0.6 ? -3.4 : -1.4 });
  const { frames } = journey(dip, 6);
  assert.ok(frames.every((f) => f.eye.y > WATER_LEVEL + EYE_CLEARANCE));
});

test('distance responds to speed steps without overshoot', () => {
  const steps: Path = (s) => ({ speed: s < 5 ? 3 : s < 25 ? 10 : 3, heading: 0.3, y: -1.4 });
  const { frames } = journey(steps, 45);
  const trail = frames.map((f) => Math.hypot(f.eye.x - f.target.x, f.eye.z - f.target.z));
  const at = (s: number) => Math.round(s * 60);
  for (let i = at(5) + 1; i < at(25); i++) assert.ok((trail[i] ?? 0) >= (trail[i - 1] ?? 0) - 1e-6, `shrank at ${String(i / 60)}s`);
  for (let i = at(25) + 1; i < trail.length; i++) assert.ok((trail[i] ?? 0) <= (trail[i - 1] ?? 0) + 1e-6, `grew at ${String(i / 60)}s`);
  assert.ok((trail[at(24.9)] ?? 0) > (trail[at(4.9)] ?? 0) + 3, 'no room made for speed');
});

test('journeys agree at 30 and 60 fps', () => {
  const a = last(journey(cruise, 10, { fps: 30 }).frames);
  const b = last(journey(cruise, 10, { fps: 60 }).frames);
  const rel = (f: typeof a) => f.eye.clone().sub(new THREE.Vector3(f.target.x, f.target.y, f.target.z));
  assert.ok(rel(a).distanceTo(rel(b)) < 0.15, `differ by ${String(rel(a).distanceTo(rel(b)))}`);
});

test('circling turns the view calmly', () => {
  const { frames } = journey(circle, 50);
  let fastest = 0;
  for (let i = 60 * 5; i < frames.length; i++) {
    const d = Math.atan2(Math.sin(item(frames, i).yaw - item(frames, i - 1).yaw), Math.cos(item(frames, i).yaw - item(frames, i - 1).yaw));
    fastest = Math.max(fastest, Math.abs(d) * 60);
  }
  assert.ok(fastest < 0.2, `yaw rate ${fastest.toFixed(3)} rad/s`);
});

test('a stopped whale turning in place does not swing the camera round', () => {
  const spin: Path = (s) => ({ speed: 0, heading: 0.8 * s, y: -1.4 });
  const { frames } = journey(spin, 8);
  const swing = Math.abs(last(frames).yaw - item(frames, 0).yaw);
  assert.ok(swing < 0.8, `swung ${swing.toFixed(2)} rad while the whale turned 6.4 rad`);
});

test('the eye follows a 200 m dive down and back, clear of the seabed, unless asked to stay at the surface', () => {
  const floor = -230;
  const camera = new THREE.PerspectiveCamera(48, 1, 0.5, 12000);
  const r = new FollowCamera(camera, { groundAt: () => floor });
  const t: FollowTarget = { x: 0, y: -1.2, z: 0, heading: 0 };
  let deepest = 0;
  for (let i = 0; i < 300 * 60; i++) {
    // Down to 200 m over two minutes, a minute there, then back up.
    const s = i / 60;
    t.y = s < 120 ? -1.2 - 198.8 * (s / 120) : s < 180 ? -200 : Math.min(-1.2, -200 + 198.8 * ((s - 180) / 100));
    t.x += 0.2;
    r.setTarget(t);
    r.update(1 / 60, s);
    deepest = Math.min(deepest, camera.position.y);
    assert.ok(camera.position.y >= floor + 2 - 1e-6, `eye ${String(camera.position.y)} m at ${s.toFixed(1)} s`);
  }
  assert.ok(deepest < -150, `eye only reached ${String(deepest)} m`);
  assert.ok(camera.position.y > WATER_LEVEL + EYE_CLEARANCE, 'came back up with the whale');

  r.setStayAtSurface(true);
  t.y = -150;
  for (let i = 0; i < 20 * 60; i++) {
    r.setTarget(t);
    r.update(1 / 60, 400 + i / 60);
  }
  assert.equal(r.mode, 'chase');
  assert.ok(camera.position.y > WATER_LEVEL + EYE_CLEARANCE, 'stayed above the water');
});
