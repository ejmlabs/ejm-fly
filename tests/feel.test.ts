import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { createWake, wakeStrength } from '../src/wake.js';
import { createBirds } from '../src/birds.js';
import { FOV, FOV_LIFT, FollowCamera, LEAN_MAX, PULL_BACK, pullBackAt } from '../src/camera.js';
import { swellAt, swellRate, SWELL_SPEED_GAIN } from '../src/swell.js';
import { cloudPatches } from '../src/sky.js';
import { patchShader } from '../src/shader-patch.js';
import { layoutWorld } from '../src/terrain.js';
import { createShip } from '../src/ships.js';
import { createShipFx } from '../src/ship-fx.js';
import { createWhalePilot, type WhaleCourse } from '../src/whale-course.js';
import { LANDMARK_CELL } from '../src/landmarks.js';
import { createWeather } from '../src/weather.js';
import { REGION_FROM, createLand } from '../src/land.js';
import { item } from '../src/item.js';

const forward = (heading: number) => ({ x: -Math.cos(heading), z: Math.sin(heading) });

test('a cruising whale leaves a wake at least 40 m long in one draw, and a slow or sunk one leaves none', () => {
  const wake = createWake();
  const heading = 0.4;
  const f = forward(heading);
  let x = 1e5;
  let z = -3e4;
  for (let i = 0; i < 30 * 12; i++) {
    x += f.x * (16 / 30);
    z += f.z * (16 / 30);
    wake.update({ x, y: 0, z, heading, speed: 16 }, 1 / 30);
  }
  assert.ok(wake.length(0.05) >= 40, `trail ${wake.length(0.05).toFixed(0)} m at 16 m/s`);
  assert.equal(wake.draws(), 1, `${String(wake.draws())} draws`);
  assert.equal(wake.group.children.length, 1, 'trail and bow wave are one mesh');
  // Vertices stay close to the source: far coordinates stay exact.
  for (const mesh of wake.group.children as THREE.Mesh[]) {
    const position = item(mesh.geometry.attributes, 'position');
    for (let i = 0; i < position.count; i++) assert.ok(Math.abs(position.getX(i)) < 400 && Math.abs(position.getZ(i)) < 400, 'vertex offsets are local');
  }
  // It fades with age: after the whale stops, the trail is gone within seconds.
  for (let i = 0; i < 30 * 9; i++) wake.update({ x, y: 0, z, heading, speed: 0 }, 1 / 30);
  assert.equal(wake.length(), 0);
  assert.equal(wake.draws(), 0);
  assert.equal(wakeStrength(20, -6), 0, 'a deep body leaves nothing');
  assert.ok(wakeStrength(20, 0) > 0.99);
  assert.ok(wakeStrength(8, 0) > 0 && wakeStrength(8, 0) < wakeStrength(16, 0), 'it grows with speed');
  wake.dispose();
});

test('the wake starts afresh after a jump rather than drawing a line across the sea', () => {
  const wake = createWake();
  for (let i = 0; i < 60; i++) wake.update({ x: i * 0.5, y: 0, z: 0, heading: Math.PI, speed: 20 }, 1 / 30);
  wake.update({ x: 40000, y: 0, z: 0, heading: Math.PI, speed: 20 }, 1 / 30);
  assert.ok(wake.length(0) < 10, `trail ${wake.length(0).toFixed(1)} m after a jump`);
});

/** Birds in render space (the group sits at the origin in tests), by reading the instance matrices. */
function birdPositions(group: THREE.Group): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const m = new THREE.Matrix4();
  for (const mesh of group.children as THREE.InstancedMesh[]) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      const scale = new THREE.Vector3().setFromMatrixScale(m);
      if (scale.x < 0.2) continue;
      out.push(new THREE.Vector3().setFromMatrixPosition(m));
    }
  }
  return out;
}

test('birds are passing flocks: they come in ahead, pass the whale at cruise and are left behind', () => {
  const birds = createBirds(42, 'high');
  const heading = 0.3;
  const f = forward(heading);
  const camera = { x: 0, y: 6, z: 0 };
  let x = 0;
  let z = 0;
  const dt = 1 / 30;
  let nearest: number;
  const nearSamples: number[] = [];
  let farthest = 0;
  const passes: number[] = [];
  let wasAhead = false;
  for (let step = 0; step < 30 * 400; step++) {
    x += f.x * 22 * dt;
    z += f.z * 22 * dt;
    camera.x = x - f.x * 18;
    camera.z = z - f.z * 18;
    birds.update(step * dt, x, z, dt, camera, false);
    if (step % 30) continue;
    const flock = birdPositions(birds.group);
    let bestAhead = -Infinity;
    nearest = Infinity;
    for (const p of flock) {
      const ahead = (p.x - x) * f.x + (p.z - z) * f.z;
      nearest = Math.min(nearest, Math.hypot(p.x - x, p.z - z));
      farthest = Math.max(farthest, Math.hypot(p.x - x, p.z - z));
      bestAhead = Math.max(bestAhead, ahead);
    }
    if (step > 30 * 5) nearSamples.push(nearest);
    // A flock was ahead of the whale and now is not: it has passed.
    const ahead = bestAhead > 60;
    if (wasAhead && !ahead) passes.push(step / 30);
    wasAhead = ahead;
  }
  assert.ok(passes.length >= 4, `${String(passes.length)} flocks passed in 400 s`);
  assert.ok(farthest < 1800, `a bird ${farthest.toFixed(0)} m from the whale`);
  // Never a flock that keeps pace: birds near the whale only for part of the time, and some of the time none are in the sky.
  const close = nearSamples.filter((d) => d < 200).length / nearSamples.length;
  assert.ok(close > 0.05 && close < 0.6, `birds within 200 m for ${(100 * close).toFixed(0)} percent of the time`);
  birds.dispose();
});

test('birds start near the whale, so the opening has a flock to see', () => {
  const birds = createBirds(42, 'high');
  const dt = 1 / 30;
  for (let i = 0; i < 90; i++) birds.update(i * dt, 0, 0, dt, { x: 0, y: 5, z: 18 }, false);
  const flock = birdPositions(birds.group);
  assert.ok(flock.length >= 3, `${String(flock.length)} birds in the opening`);
  assert.ok(flock.some((p) => Math.hypot(p.x, p.z) < 400));
  birds.dispose();
});

test('the swell runs faster the faster the whale swims', () => {
  assert.equal(swellRate(0), 1);
  assert.equal(swellRate(1), 1 + SWELL_SPEED_GAIN);
  assert.equal(swellRate(3), swellRate(1));
  assert.ok(swellRate(0.5) > swellRate(0.3));
  // A clock that runs 2.5 times as fast moves the same wave 2.5 times as far.
  const a = swellAt(10, 20, 4);
  const b = swellAt(10, 20, 4 * swellRate(1));
  assert.notEqual(a.height, b.height);
});

test('the sky patches onto three.js: its clouds take a wind vector and a low sun warms its horizon', () => {
  const patched = patchShader(new Sky().material.fragmentShader, cloudPatches);
  assert.ok(patched, 'the clouds patch found its place in the sky shader');
  assert.ok(patched.includes('cloudUV += time * cloudSpeed * cloudWind;'));
  assert.ok(patched.includes('texColor *= 1.0 + skyGlow * exp( -abs( direction.y )'), 'the horizon belt is in the sky shader, thinning both ways from the horizon');
});

function chase(options: { portrait?: boolean } = {}) {
  const camera = new THREE.PerspectiveCamera(options.portrait ? FOV[1] : FOV[0], options.portrait ? 0.46 : 1.6, 0.5, 12000);
  return { camera, rig: new FollowCamera(camera, { portrait: options.portrait }) };
}

/** Rolls the rig along a straight swim with the whale speeding up, and returns what the camera did. */
function swim(rig: FollowCamera, camera: THREE.PerspectiveCamera, from: number, to: number, seconds: number, reduced = false, turn = 0) {
  const dt = 1 / 30;
  let x = 0;
  let z = 0;
  let heading = 0;
  let worst = 0;
  let farthest = 0;
  const steps = seconds / dt;
  for (let i = 0; i < steps; i++) {
    const speed = from + (to - from) * Math.min(1, i / (steps * 0.5));
    heading += turn * dt;
    const f = forward(heading);
    x += f.x * speed * dt;
    z += f.z * speed * dt;
    rig.setTarget({ x, y: -0.6, z, heading });
    rig.update(dt, i * dt, reduced);
    if (i > steps * 0.1) {
      worst = Math.max(worst, rig.framingError(camera.position.x, camera.position.y, camera.position.z, rig.lookAt.x, rig.lookAt.y, rig.lookAt.z));
      farthest = Math.max(farthest, rig.distance);
    }
  }
  return { worst, farthest };
}

test('the camera at speed pulls back at most a quarter, lifts the view at most 6 degrees and keeps the whale in the middle 80 percent', () => {
  assert.equal(pullBackAt(0), 0);
  assert.ok(pullBackAt(28) <= PULL_BACK + 1e-9 && pullBackAt(28) > 0.2, `pull-back ${String(pullBackAt(28))}`);
  assert.equal(pullBackAt(60), pullBackAt(28));
  assert.ok(pullBackAt(10) < pullBackAt(20));
  for (const portrait of [false, true]) {
    const slow = chase({ portrait });
    swim(slow.rig, slow.camera, 0, 0, 20);
    const fast = chase({ portrait });
    const { worst } = swim(fast.rig, fast.camera, 16, 28, 40);
    const lift = fast.camera.fov - FOV[portrait ? 1 : 0];
    assert.ok(lift > 4.5 && lift <= FOV_LIFT + 1e-6, `field of view lifted ${lift.toFixed(2)} degrees (portrait ${String(portrait)})`);
    assert.ok(worst <= 0.8, `the whale reached ${worst.toFixed(2)} of the half frame (portrait ${String(portrait)})`);
    assert.equal(slow.camera.fov, FOV[portrait ? 1 : 0], 'no lift at rest');
  }
});

test('the camera leans into a turn, a little and the right way', () => {
  const roll = (camera: THREE.PerspectiveCamera): number => {
    camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    return Math.asin(right.y);
  };
  const left = chase();
  swim(left.rig, left.camera, 24, 24, 20, false, 0.12);
  const right = chase();
  swim(right.rig, right.camera, 24, 24, 20, false, -0.12);
  const straight = chase();
  swim(straight.rig, straight.camera, 24, 24, 20);
  assert.ok(roll(left.camera) > 0.004, `left turn roll ${roll(left.camera).toFixed(4)}`);
  assert.ok(roll(right.camera) < -0.004, `right turn roll ${roll(right.camera).toFixed(4)}`);
  assert.ok(Math.abs(roll(left.camera)) <= LEAN_MAX + 1e-3 && Math.abs(roll(right.camera)) <= LEAN_MAX + 1e-3);
  assert.ok(Math.abs(roll(straight.camera)) < 0.003, `straight roll ${roll(straight.camera).toFixed(4)}`);
});

test('reduced motion: no field-of-view lift, no lean, no pull-back beyond the plain follow', () => {
  const { camera, rig } = chase();
  swim(rig, camera, 20, 28, 20, true, 0.12);
  assert.equal(camera.fov, FOV[0]);
  camera.updateMatrixWorld();
  assert.ok(Math.abs(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).y) < 1e-6);
});

test('landmarks pass the route: at least four within 1.5 km in ten minutes of open ocean, and the opening is left alone', () => {
  for (const seed of [42, 7, 1234, 99, 2024, 31337]) {
    const layout = layoutWorld(seed);
    const land = layout.land;
    const pilot = createWhalePilot(seed, layout.whaleHome, layout.journey);
    const course: WhaleCourse = { x: layout.whaleHome.x, z: layout.whaleHome.z, heading: layout.journey, leg: layout.journey, speed: 22 };
    land.nav.prefetch(course.x, course.z, 700, Infinity);
    const seen = new Set<string>();
    for (let i = 0; i < 600 * 30; i++) {
      if (i % 150 === 0) land.nav.prefetch(course.x, course.z, 3400, Infinity);
      pilot.step(course, 1 / 30, i / 30, land);
      if (i % 30) continue;
      const ci = Math.floor(course.x / LANDMARK_CELL);
      const cj = Math.floor(course.z / LANDMARK_CELL);
      for (let a = ci - 1; a <= ci + 1; a++) {
        for (let b = cj - 1; b <= cj + 1; b++) {
          const mark = land.landmarks.cell(a, b);
          if (Math.hypot(mark.x, mark.z) > 5000 && Math.hypot(mark.x - course.x, mark.z - course.z) < 1500) seen.add(`${String(a)}:${String(b)}`);
        }
      }
    }
    assert.ok(seen.size >= 4, `seed ${String(seed)}: ${String(seen.size)} landmarks within 1.5 km in 600 s`);
  }
}, 120000);

test('landmarks that stand alone in the sea break the surface, small and low', () => {
  for (const seed of [42, 7, 1234]) {
    const land = layoutWorld(seed).land;
    let alone = 0;
    for (let i = -8; i <= 8; i++) {
      for (let j = -8; j <= 8; j++) {
        const mark = land.landmarks.cell(i, j);
        if (Math.hypot(mark.x, mark.z) < 5200) continue;
        // Those that stand are what is judged; one near a coast has none.
        if (land.maskAt(mark.x, mark.z) <= 0) continue;
        assert.equal(land.landmarks.at(mark.x + mark.radius * 6, mark.z), 0);
        // Beside a coast the landmark joins it; only the ones with open sea all round are judged.
        let sea = true;
        for (let k = 0; k < 12 && sea; k++) sea = land.maskAt(mark.x + Math.cos(k) * 5 * mark.radius, mark.z + Math.sin(k) * 5 * mark.radius) < 0;
        if (!sea) continue;
        alone++;
        const high = land.heightAt(mark.x, mark.z);
        assert.ok(high > 0 && high < 60, `landmark ${String(i)}:${String(j)} of seed ${String(seed)} is ${high.toFixed(0)} m high`);
      }
    }
    assert.ok(alone > 60, `${String(alone)} lone landmarks`);
  }
});

test('the opening is untouched: with or without landmarks the mask is the same within the region fade-in radius', () => {
  const land = layoutWorld(42).land;
  const bare = createLand(42, { viewYaw: land.viewYaw, offset: land.offset, landmarks: false });
  let beyond = 0;
  for (let a = 0; a < 400; a++) {
    const r = (a / 400) * REGION_FROM;
    const x = Math.cos(a * 2.4) * r;
    const z = Math.sin(a * 2.4) * r;
    assert.equal(bare.maskAt(x, z), land.maskAt(x, z), `the mask changed at ${r.toFixed(0)} m`);
  }
  // Out beyond it they are there: the masks differ somewhere.
  for (let a = 0; a < 4000; a++) {
    const x = Math.cos(a * 2.4) * (6000 + a * 3);
    const z = Math.sin(a * 2.4) * (6000 + a * 3);
    if (bare.maskAt(x, z) !== land.maskAt(x, z)) beyond++;
  }
  assert.ok(beyond > 0, 'no landmark beyond the opening');
});

test('a landmark stands only in open water: sea all round it out to a kilometre', () => {
  for (const seed of [3, 13, 42]) {
    const land = layoutWorld(seed).land;
    const bare = createLand(seed, { viewYaw: land.viewYaw, offset: land.offset, landmarks: false });
    let stood = 0;
    for (let i = -10; i <= 10; i++) {
      for (let j = -10; j <= 10; j++) {
        const mark = land.landmarks.cell(i, j);
        if (Math.hypot(mark.x, mark.z) < REGION_FROM) continue;
        // Land that is there without the landmark is the coast's own.
        if (land.maskAt(mark.x, mark.z) <= 0 || bare.maskAt(mark.x, mark.z) > 0) continue;
        stood++;
        for (const ring of [400, 1000]) {
          for (let k = 0; k < 16; k++) {
            const x = mark.x + Math.cos((k / 16) * Math.PI * 2) * ring;
            const z = mark.z + Math.sin((k / 16) * Math.PI * 2) * ring;
            assert.ok(bare.maskAt(x, z) < 0, `landmark ${String(i)}:${String(j)} of seed ${String(seed)} stands by a natural coast at ${String(ring)} m`);
          }
        }
      }
    }
    assert.ok(stood > 100, `${String(stood)} landmarks stand on seed ${String(seed)}`);
  }
});

test('an unknown weather state is ignored', () => {
  const w = createWeather(1);
  w.set('overcast');
  w.set('hail' as never);
  w.update(1, 1, [1, 0, 0, 0]);
  assert.ok(Number.isFinite(w.look.coverage) && w.target() === 'overcast');
});

test('ships are two meshes each (hull and rig, and the sails), shaped, and sway without going wrong', () => {
  for (const seed of [42, 7]) {
    const specs = layoutWorld(seed).ships;
    assert.ok(specs.length >= 2);
    for (const spec of specs) {
      const ship = createShip(spec);
      assert.equal(ship.group.children.length, 2, 'a ship is two draws');
      const hull = item((ship.group.children[0] as THREE.Mesh).geometry.attributes, 'position');
      assert.ok(hull.count > 300, 'a hull and its rig');
      assert.equal(ship.lanterns.length, 2);
      assert.ok(ship.size.length > 3 && ship.size.beam > 1);
      const stub = { clearance: () => 1000, away: () => ({ x: 1, z: 0 }) };
      for (let i = 0; i < 120; i++) ship.update(1 / 30, i / 30, stub);
      const sails = item((ship.group.children[1] as THREE.Mesh).geometry.attributes, 'position');
      for (let i = 0; i < sails.count; i++) assert.ok(Number.isFinite(sails.getX(i) + sails.getY(i) + sails.getZ(i)));
      // The sails hang inside the hull's reach: a ship is a ship, not a smear.
      const box = new THREE.Box3().setFromBufferAttribute(sails as THREE.BufferAttribute);
      assert.ok(box.max.y > 2 && box.max.y < 9 && box.max.x - box.min.x < 6, `sail box ${String(box.min.toArray())} ${String(box.max.toArray())}`);
      ship.dispose();
    }
  }
});

test('a ship told not to billow still moves but leaves its sails as they were', () => {
  const stub = { clearance: () => 1000, away: () => ({ x: 1, z: 0 }) };
  const ship = createShip(item(layoutWorld(42).ships, 0));
  const sails = () => (item(ship.group.children, 1) as THREE.Mesh).geometry.getAttribute('position').array.slice();
  ship.update(1 / 30, 0, stub);
  const before = sails();
  const at = ship.group.position.clone();
  ship.update(1 / 30, 1.3, stub, false);
  assert.deepEqual(sails(), before);
  assert.ok(!ship.group.position.equals(at), 'the hull still rides the swell');
  ship.update(1 / 30, 1.3, stub);
  assert.notDeepEqual(sails(), before, 'the sails sway when asked to');
  ship.dispose();
});

test('ships have foam always and lanterns only in the dark, in two draws for all of them', () => {
  const stub = { clearance: () => 1000, away: () => ({ x: 1, z: 0 }) };
  const ships = layoutWorld(42).ships.map((spec) => createShip(spec));
  ships.forEach((ship) => { ship.update(1 / 30, 0, stub); });
  const fx = createShipFx();
  fx.update(ships, 1);
  assert.equal(fx.draws(), 1, 'by day only foam');
  fx.update(ships, 0.05);
  assert.equal(fx.draws(), 2, 'at night foam and lanterns');
  fx.update([], 0.05);
  assert.equal(fx.draws(), 0);
  ships.forEach((ship) => { ship.dispose(); });
  fx.dispose();
});

test('the page\'s land and the worker\'s agree about every landmark near the start, on many seeds', () => {
  // The page searches for its opening; the worker is handed the offset found. A landmark answer cached during
  // the search for a trial offset must not outlive it.
  let checked = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const main = layoutWorld(seed).land;
    const worker = createLand(seed, { viewYaw: main.viewYaw, offset: main.offset });
    for (let i = -3; i <= 2; i++) {
      for (let j = -3; j <= 2; j++) {
        const mark = main.landmarks.cell(i, j);
        assert.equal(main.maskAt(mark.x, mark.z), worker.maskAt(mark.x, mark.z), `seed ${String(seed)}: landmark ${String(i)}:${String(j)} differs between the page's land and the worker's`);
        checked++;
      }
    }
  }
  assert.equal(checked, 60 * 36);
}, 180000);
