import { test, expect } from 'vitest';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EYE_CLEARANCE, FollowCamera } from '../src/camera.js';
import { WATER_LEVEL } from '../src/seams.js';
import { PACES, isPace } from '../src/pace.js';
import { validateMemory, VERSION } from '../src/persistence.js';
import { circleShore } from '../src/shore.js';
import { createWhaleMover, TRAVEL_MAX } from '../src/whale-behavior.js';
import { ORBIT_DISTANCE, createViewControls } from '../src/view-controls.js';

/** Just enough of a canvas for OrbitControls to attach its listeners. */
function stubCanvas(): HTMLCanvasElement {
  const el = Object.assign(new EventTarget(), { style: {}, clientWidth: 800, clientHeight: 600 });
  return Object.assign(el, { getRootNode: () => el, ownerDocument: el }) as unknown as HTMLCanvasElement;
}

function key(canvas: HTMLCanvasElement, name: string, times = 1): void {
  for (let i = 0; i < times; i++) canvas.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: name }));
}

function setup() {
  const camera = new THREE.PerspectiveCamera(48, 800 / 600, 0.5, 12000);
  const rig = new FollowCamera(camera);
  const canvas = stubCanvas();
  const changes: boolean[] = [];
  const view = createViewControls(canvas, rig, (on) => changes.push(on));
  const target = { x: 0, y: 0, z: 0, heading: 0 };
  /** Whale speed along its heading, m/s. */
  const swim = { speed: 0 };
  const run = (seconds: number, reducedMotion = false) => {
    for (let i = 0; i < seconds * 60; i++) {
      target.x -= Math.cos(target.heading) * swim.speed / 60;
      target.z += Math.sin(target.heading) * swim.speed / 60;
      rig.setTarget(target);
      view.update(reducedMotion);
      rig.update(1 / 60, 0, reducedMotion);
    }
  };
  const distance = () => camera.position.distanceTo(new THREE.Vector3(target.x, target.y, target.z));
  return { camera, rig, canvas, view, changes, target, swim, run, distance };
}

test('pace choices: normal is the current speed, fast tops out at 1.5 times', () => {
  assert.equal(PACES.normal, 1);
  expect(PACES.slow).toBeLessThan(1);
  expect(PACES.fast).toBeLessThanOrEqual(1.5);
  assert.ok(isPace('fast') && !isPace('warp') && !isPace('toString') && !isPace(2));
  assert.ok(validateMemory({ version: VERSION, seed: 1, pace: 'slow' }));
  assert.ok(!validateMemory({ version: VERSION, seed: 1, pace: 'warp' }));
  assert.ok(validateMemory({ version: VERSION, seed: 1 }));
});

test('pace scales the cruising speed and the whale still breathes', () => {
  const mean = (pace: number) => {
    const mover = createWhaleMover(7, { x: 0, z: 0 }, 0.4);
    mover.pace = pace;
    let sum = 0;
    let top = 0;
    let breaths = 0;
    let last = mover.motion.behavior;
    const steps = 600 * 30;
    for (let i = 0; i < steps; i++) {
      mover.step(1 / 30, i / 30, circleShore([]));
      sum += mover.motion.speed;
      top = Math.max(top, mover.motion.speed);
      if (mover.motion.behavior === 'breathe' && last !== 'breathe') breaths++;
      last = mover.motion.behavior;
    }
    return { speed: sum / steps, top, breaths };
  };
  const slow = mean(PACES.slow);
  const normal = mean(PACES.normal);
  const fast = mean(PACES.fast);
  assert.ok(slow.speed < normal.speed * 0.75, `slow ${String(slow.speed)} vs ${String(normal.speed)}`);
  assert.ok(fast.speed > normal.speed * 1.3, `fast ${String(fast.speed)} vs ${String(normal.speed)}`);
  assert.ok(fast.top < TRAVEL_MAX * PACES.fast + 6, `fast top ${String(fast.top)}`);
  assert.ok(fast.breaths >= 2 && slow.breaths >= 2, `breaths ${String(slow.breaths)} ${String(fast.breaths)}`);
});

test('the follow camera stays the default until the user orbits', () => {
  const { rig, view, changes, run } = setup();
  run(2);
  assert.equal(view.orbiting, false);
  assert.equal(rig.mode, 'chase');
  assert.deepEqual(changes, []);
});

test('keys orbit a full turn and zoom stays within the limits', () => {
  const { camera, canvas, view, changes, target, run, distance } = setup();
  run(2);
  key(canvas, 'ArrowLeft', 13); // about π/2: a side view
  run(3);
  assert.equal(view.orbiting, true);
  assert.deepEqual(changes, [true]);
  // A full turn in steps: the eye passes through every quadrant around the whale.
  const quadrants = new Set<number>();
  for (let i = 0; i < 14; i++) {
    key(canvas, 'ArrowLeft', 4);
    run(0.5);
    const a = Math.atan2(camera.position.x - target.x, camera.position.z - target.z);
    quadrants.add(Math.floor(((a + Math.PI) / (Math.PI / 2)) % 4));
  }
  assert.equal(quadrants.size, 4);

  key(canvas, '+', 40);
  run(4);
  assert.ok(distance() >= ORBIT_DISTANCE[0] - 0.5, `too close ${String(distance())}`);
  assert.ok(distance() < ORBIT_DISTANCE[0] * 1.2, `zoomed in ${String(distance())}`);
  key(canvas, '-', 60);
  run(4);
  assert.ok(distance() <= ORBIT_DISTANCE[1] + 0.5, `too far ${String(distance())}`);
  assert.ok(distance() > ORBIT_DISTANCE[1] * 0.9, `zoomed out ${String(distance())}`);
});

test('the pitch never goes under the water or over the top', () => {
  const { camera, canvas, target, run } = setup();
  run(1);
  key(canvas, 'ArrowDown', 60);
  run(3);
  assert.ok(camera.position.y >= WATER_LEVEL + EYE_CLEARANCE - 1e-6, `eye ${String(camera.position.y)}`);
  key(canvas, 'ArrowUp', 80);
  run(3);
  const flat = Math.hypot(camera.position.x - target.x, camera.position.z - target.z);
  assert.ok(flat > 1, `over the top ${String(flat)}`);
});

test('after letting go the view keeps its angle to the turning whale', () => {
  const { camera, canvas, target, swim, run } = setup();
  swim.speed = 20;
  run(3);
  key(canvas, 'ArrowLeft', 13);
  run(3);
  const relative = () => {
    const a = Math.atan2(camera.position.x - target.x, camera.position.z - target.z) - target.heading;
    return Math.atan2(Math.sin(a), Math.cos(a));
  };
  const before = relative();
  target.heading = 1.2;
  run(12);
  assert.ok(Math.abs(relative() - before) < 0.1, `${String(before)} → ${String(relative())}`);
});

test('reset returns to the follow camera; reduced motion does not drift', () => {
  const { camera, canvas, view, changes, run } = setup();
  run(1);
  key(canvas, 'ArrowLeft', 5);
  run(0.1, true);
  const held = camera.position.clone();
  run(2, true);
  assert.ok(camera.position.distanceTo(held) < 1e-6, 'drifted after the keys');
  key(canvas, '0');
  assert.equal(view.orbiting, false);
  assert.deepEqual(changes, [true, false]);
});
