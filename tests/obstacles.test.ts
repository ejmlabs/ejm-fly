import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';
import {
  OBSTACLE_CELL,
  WHALE_RADIUS,
  capsulesOverlap,
  createMoverSync,
  createObstacles,
  createSurfaces,
  groundClearance,
  rayCapsule,
  shipCapsule,
  whaleCapsule,
  type Obstacle,
} from '../src/obstacles.js';
import { random } from '../src/rng.js';
import { layoutWorld } from '../src/terrain.js';
import { createSeafloor } from '../src/seafloor.js';
import { swellAt } from '../src/swell.js';
import { createShip, SHIP_SIZE } from '../src/ships.js';
import { WHALE_LENGTH } from '../src/whale-model.js';
import { whaleForward } from '../src/whale-course.js';
import { item } from '../src/item.js';

const land = layoutWorld(42, 140).land;
const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const capsule = (a: THREE.Vector3, b: THREE.Vector3, r: number): Capsule => new Capsule(a, b, r);

test('capsules overlap when their axes are within the sum of the radii: crossing, parallel, end-to-end and points', () => {
  const touch = (a: Capsule, b: Capsule, gap: number) => {
    // `gap` is the distance between the axes; just under it they overlap, just over it they do not.
    const r = gap / 2;
    assert.equal(capsulesOverlap(new Capsule(a.start, a.end, r + 1e-9), new Capsule(b.start, b.end, r)), true);
    assert.equal(capsulesOverlap(new Capsule(a.start, a.end, r - 1e-9), new Capsule(b.start, b.end, r)), false);
  };
  touch(capsule(v(-1, 0, 0), v(1, 0, 0), 0), capsule(v(0, 2, -1), v(0, 2, 1), 0), 2);
  touch(capsule(v(0, 0, 0), v(4, 0, 0), 0), capsule(v(1, 0, 3), v(3, 0, 3), 0), 3);
  touch(capsule(v(0, 0, 0), v(1, 0, 0), 0), capsule(v(3, 0, 0), v(5, 0, 0), 0), 2);
  touch(capsule(v(2, 0, 0), v(2, 0, 0), 0), capsule(v(0, 1, 0), v(4, 1, 0), 0), 1);
  touch(capsule(v(0, 0, 0), v(0, 0, 0), 0), capsule(v(3, 4, 0), v(3, 4, 0), 0), 5);
});

const segment = new THREE.Line3();
const onSegment = new THREE.Vector3();
const along = new THREE.Vector3();

/** Distance from `p` to the segment a–b. */
function pointSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  segment.set(a, b);
  if (a.equals(b)) return p.distanceTo(a);
  return segment.closestPointToPoint(p, true, onSegment).distanceTo(p);
}

/** Least of a convex function on [lo, hi] by ternary search, as [argument, value]. */
function convexMin(f: (u: number) => number, lo: number, hi: number): [number, number] {
  for (let k = 0; k < 200; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) < f(m2)) hi = m2;
    else lo = m1;
  }
  const u = (lo + hi) / 2;
  return [u, f(u)];
}

/**
 * Reference ray–capsule distance within `length`, independent of the closed form: the distance from a point of the ray
 * to the axis is convex along the ray, so a ternary search finds where it is least and bisection the first touch.
 */
function rayCapsuleReference(ro: THREE.Vector3, rd: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number, length: number): number {
  const f = (t: number) => pointSegment(along.copy(rd).multiplyScalar(t).add(ro), a, b);
  if (f(0) <= r) return 0;
  const [tMin, least] = convexMin(f, 0, length);
  if (least > r) return -1;
  let lo = 0;
  let hi = tMin;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) <= r) hi = mid;
    else lo = mid;
  }
  return hi;
}

test('ray meets a capsule on its body, its caps, as a sphere, from inside, or not at all', () => {
  const a = v(0, 0, -5);
  const b = v(0, 0, 5);
  const close = (got: number, want: number) => { assert.ok(Math.abs(got - want) < 1e-9, `${String(got)} vs ${String(want)}`); };
  close(rayCapsule(v(-10, 0, 0), v(1, 0, 0), a, b, 1), 9);
  close(rayCapsule(v(0, 0, -20), v(0, 0, 1), a, b, 1), 14);
  close(rayCapsule(v(0, 0, 20), v(0, 0, -1), a, b, 1), 14);
  close(rayCapsule(v(-10, 0, 7), v(1, 0, 0), a, b, 3), 10 - Math.sqrt(5));
  close(rayCapsule(v(0, 0, -10), v(0, 0, 1), v(0, 0, 0), v(0, 0, 0), 2), 8);
  assert.equal(rayCapsule(v(0, 0.5, 0), v(1, 0, 0), a, b, 1), 0);
  assert.equal(rayCapsule(v(-10, 3, 0), v(1, 0, 0), a, b, 1), -1);
  assert.ok(rayCapsule(v(10, 0, 0), v(1, 0, 0), a, b, 1) < 0, 'behind the ray');
});

test('the ray–capsule closed form agrees with an independent search, including pitched, point and near-axis cases', () => {
  const rng = random(11);
  const length = 400;
  let hits = 0;
  for (let q = 0; q < 3000; q++) {
    const a = v((rng() - 0.5) * 200, (rng() - 0.5) * 60, (rng() - 0.5) * 200);
    const pitch = (rng() - 0.5) * 1.5;
    const yaw = rng() * Math.PI * 2;
    const reach = q % 5 === 0 ? 0 : rng() * 80;
    const axis = v(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch));
    const b = a.clone().addScaledVector(axis, reach);
    const r = 0.5 + rng() * 8;
    let ro: THREE.Vector3;
    let rd: THREE.Vector3;
    if (q % 4 === 0 && reach > 0) {
      // Nearly along the axis, coming from beyond one cap.
      const tilt = v(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(2e-4);
      const from = q % 8 === 0 ? a : b;
      const out = q % 8 === 0 ? -1 : 1;
      ro = from.clone().addScaledVector(axis, out * (r + 5 + rng() * 50)).add(v(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(r));
      rd = axis.clone().multiplyScalar(-out).add(tilt).normalize();
    } else {
      ro = v((rng() - 0.5) * 400, (rng() - 0.5) * 100, (rng() - 0.5) * 400);
      rd = a.clone().lerp(b, rng()).add(v(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(30)).sub(ro).normalize();
    }
    const got = rayCapsule(ro, rd, a, b, r);
    const want = rayCapsuleReference(ro, rd, a, b, r, length);
    const gotHit = got >= 0 && got <= length;
    if (want < 0) {
      // A graze within the reference's tolerance may go either way.
      if (gotHit) assert.ok(Math.abs(pointSegment(along.copy(rd).multiplyScalar(got).add(ro), a, b) - r) < 1e-6, `${String(q)}: false hit`);
      continue;
    }
    assert.ok(gotHit, `${String(q)}: missed at ${String(want)}`);
    assert.ok(Math.abs(got - want) < 1e-5, `${String(q)}: ${String(got)} vs ${String(want)}`);
    hits++;
  }
  assert.ok(hits > 1000, `${String(hits)} hits`);
});

test('the registry answers overlap and feeler queries exactly as a brute-force check does, frame after frame', () => {
  const rng = random(7);
  const span = OBSTACLE_CELL * 6;
  const obstacles = createObstacles();
  let overlapping = 0;
  let hits = 0;
  // Far from the origin too, where cell keys are large.
  for (const base of [0, 1e6, -3.2e7]) {
    // Some coordinates sit exactly on cell borders, give or take a hair.
    const pick = () => {
      const x = base + (rng() - 0.5) * span;
      return rng() < 0.4 ? Math.round(x / OBSTACLE_CELL) * OBSTACLE_CELL + (rng() - 0.5) * 2e-9 : x;
    };
    const placed: Obstacle[] = [];
    for (let i = 0; i < 120; i++) placed.push({ kind: i % 3 === 0 ? 'rock' : 'ship', capsule: new Capsule() });
    // The same obstacles move between frames, as movers do, and half leave in the last; nothing earlier may linger.
    for (let frame = 0; frame < 3; frame++) {
      obstacles.clear();
      const live = frame === 2 ? placed.slice(0, placed.length / 2) : placed;
      for (const [i, obstacle] of live.entries()) {
        const at = v(pick(), (rng() - 0.5) * 20, pick());
        const reach = i % 3 === 0 ? 0 : 4 + rng() * 120;
        const yaw = rng() * Math.PI * 2;
        const pitch = i % 7 === 0 ? Math.PI / 2 - rng() * 0.01 : (rng() - 0.5) * 1.5;
        const tip = at.clone().add(v(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)).multiplyScalar(reach));
        obstacle.capsule.set(at, tip, i % 11 === 0 ? 0 : 1 + rng() * 6);
        obstacles.add(obstacle);
      }
      assert.equal(obstacles.size, live.length);

      const found: Obstacle[] = [];
      for (let q = 0; q < 200; q++) {
        const probe = capsule(v(pick(), 0, pick()), v((rng() - 0.5) * 60, (rng() - 0.5) * 20, (rng() - 0.5) * 60), 2 + rng() * 6);
        probe.end.add(probe.start);
        const ignore = item(live, q % live.length);
        const got = obstacles.overlaps(probe, ignore, found);
        assert.equal(got, found);
        const want = live.filter((o) => o !== ignore && capsulesOverlap(probe, o.capsule));
        assert.deepEqual(new Set(got), new Set(want));
        assert.equal(got.length, new Set(got).size, 'an obstacle across cells is reported once');
        overlapping += got.length;

        const origin = v(pick(), (rng() - 0.5) * 10, pick());
        const direction = v(rng() - 0.5, (rng() - 0.5) * 0.4, rng() - 0.5).normalize();
        const length = 20 + rng() * 400;
        const radius = rng() * 3;
        const hit = obstacles.feeler(origin, direction, length, radius);
        let nearest = Infinity;
        for (const o of live) {
          const t = rayCapsule(origin, direction, o.capsule.start, o.capsule.end, o.capsule.radius + radius);
          if (t >= 0 && t <= length) nearest = Math.min(nearest, t);
        }
        if (nearest === Infinity) assert.equal(hit, null);
        else {
          assert.ok(hit);
          assert.equal(hit.distance, nearest);
          hits++;
        }
      }
    }
  }
  assert.ok(overlapping > 200 && hits > 200, `queries exercised: ${String(overlapping)} overlaps, ${String(hits)} hits`);

  obstacles.clear();
  assert.equal(obstacles.size, 0);
  assert.equal(obstacles.feeler(v(0, 0, 0), v(1, 0, 0), OBSTACLE_CELL * 6), null);
});

test('the whale capsule spans the whale along its heading and pitch', () => {
  for (const [heading, pitch] of [[0, 0], [1.1, 0], [-2.4, 0.3]] as const) {
    const c = whaleCapsule({ x: 100, y: -3, z: -40, heading, pitch });
    const axis = c.start.clone().sub(c.end);
    assert.ok(Math.abs(axis.length() + 2 * WHALE_RADIUS - WHALE_LENGTH) < 1e-9);
    const forward = whaleForward(heading);
    axis.normalize();
    assert.ok(Math.abs(axis.y - Math.sin(pitch)) < 1e-9);
    assert.ok(Math.abs(axis.x - forward.x * Math.cos(pitch)) < 1e-9 && Math.abs(axis.z - forward.z * Math.cos(pitch)) < 1e-9);
  }
});

test('a ship capsule lies along its hull at the waterline and blocks a feeler', () => {
  const ship = createShip({ id: 1, x: 300, z: 200, heading: 0.7, scale: 1, kind: 'tall', seed: 99 });
  ship.update(0.016, 0, land);
  const c = shipCapsule(ship);
  const length = ship.size.length * SHIP_SIZE;
  assert.ok(Math.abs(c.start.distanceTo(c.end) + 2 * c.radius - length) < 1e-9);
  assert.equal(c.radius, (ship.size.beam / 2) * SHIP_SIZE);
  const hull = new THREE.Box3().setFromObject(ship.group);
  const middle = c.start.clone().add(c.end).multiplyScalar(0.5);
  assert.ok(hull.containsPoint(middle) && Math.abs(middle.y) < 1);

  const obstacles = createObstacles();
  const obstacle: Obstacle = { kind: 'ship', capsule: c };
  obstacles.add(obstacle);
  const whale = whaleCapsule({ x: middle.x, y: -0.4, z: middle.z, heading: 0, pitch: 0 });
  assert.deepEqual(obstacles.overlaps(whale), [obstacle]);
  assert.deepEqual(obstacles.overlaps(whale, obstacle), []);
  const from = middle.clone().add(v(0, 0, -200));
  const hit = obstacles.feeler(from, v(0, 0, 1), 300, WHALE_RADIUS);
  assert.ok(hit?.obstacle === obstacle && hit.distance > 150 && hit.distance < 200);
  ship.dispose();
});

test('the surfaces are the seafloor and the swell, and clearance goes negative inside the ground', () => {
  const seafloor = createSeafloor(42, land);
  const surfaces = createSurfaces(seafloor);
  let onLand = 0;
  let atSea = 0;
  for (let i = 0; i < 400; i++) {
    const x = ((i * 7919) % 6000) - 3000;
    const z = ((i * 104729) % 6000) - 3000;
    const ground = seafloor.heightAt(x, z);
    assert.equal(surfaces.groundAt(x, z), ground);
    assert.equal(surfaces.seaAt(x, z, i * 0.7), swellAt(x, z, i * 0.7).height);
    if (ground > 2) {
      onLand++;
      assert.ok(groundClearance(surfaces, capsule(v(x, ground - 4, z), v(x, ground - 4, z), 1)) < 0);
    } else if (ground < -12) {
      atSea++;
      assert.ok(Math.abs(groundClearance(surfaces, capsule(v(x, -2, z), v(x, -2, z), 1)) - (-3 - ground)) < 1e-9);
    }
  }
  assert.ok(onLand > 10 && atSea > 10, `${String(onLand)} on land, ${String(atSea)} at sea`);
});

test('the mover sync registers the whale and the ships afloat afresh each frame', () => {
  const obstacles = createObstacles();
  const sync = createMoverSync(obstacles);
  const ship = createShip({ id: 2, x: 0, z: 0, heading: 0, scale: 1, kind: 'sloop', seed: 5 });
  ship.update(0.016, 0, land);
  const whale = { phase: 'swim', phaseT: 0, behavior: 'travel', speed: 0, x: 500, y: -0.4, z: 0, heading: 0, pitch: 0, roll: 0, spout: 0, splash: 0 } as const;
  sync(whale, [ship]);
  assert.equal(obstacles.size, 2);
  assert.deepEqual(obstacles.overlaps(whaleCapsule(whale)).map((o) => o.kind), ['whale']);
  sync({ ...whale, x: ship.group.position.x, z: ship.group.position.z }, []);
  assert.equal(obstacles.size, 1);
  assert.deepEqual(obstacles.overlaps(shipCapsule(ship)).map((o) => o.kind), ['whale']);
  ship.dispose();
});
