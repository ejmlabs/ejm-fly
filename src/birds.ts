import * as THREE from 'three';
import { fork } from './rng.js';
import { damp } from './math.js';
import { selectLod } from './lod.js';
import { detailFor, type QualityTier } from './quality.js';
import { buildBird, patchBirdShader, SPECIES, triangleCount } from './bird-mesh.js';
import { stepFlock, type Boid, type Leader } from './flock.js';
import { item } from './item.js';

/** Metres from the camera at which birds drop to the mid and far meshes. */
const LOD_BOUNDS = [40, 120] as const;
/** Lowest height over the water (m). */
const MIN_HEIGHT = 5;
const MAX_HEIGHT = 70;
const MAX_BIRDS = 24;
/** Species of a bird by its fixed roll, for a share of gulls, terns, albatrosses (the rest). */
const speciesFor = (roll: number, mix: readonly [number, number, number]): number => (roll < mix[0] ? 0 : roll < mix[0] + mix[1] ? 1 : 2);

/** Seconds a bird takes to appear or vanish when the tier changes or its flock comes and goes. */
const FADE_SECONDS = 1;
/** A flock appears this far ahead of the whale along its course (m), and off to one side by this much. */
const AHEAD: readonly [number, number] = [420, 760];
const ABEAM: readonly [number, number] = [50, 210];
/** It has passed once it is this far behind, and is gone then; the next one comes after a pause (s). */
const GONE_BEHIND = 380;
const PAUSE: readonly [number, number] = [4, 24];

type Bird = Boid & { roll: number; phase: number; heading: number; bank: number; lod: number; tint: THREE.Color; fade: number };

export interface Birds {
  group: THREE.Group;
  update: (time: number, centerX?: number, centerZ?: number, dt?: number, camera?: { x: number; y: number; z: number }, calm?: boolean) => void;
  setTier: (tier: QualityTier) => void;
  /** Share of gulls, terns and albatrosses (a region's mix); birds change species out of sight. */
  setMix: (mix: readonly [number, number, number]) => void;
  stats: () => { birds: number; draws: number; triangles: number };
  dispose: () => void;
}

/**
 * Gulls, terns and albatrosses flying as small flocks that circle a spot of sea. At cruise speed the whale
 * outruns them, so a flock appears ahead, passes the whale and is gone behind, and the next one comes after
 * a pause. Each species is an instanced mesh at three levels of detail; wing flap runs in the vertex shader.
 * Same seed, same birds.
 */
export function createBirds(seed: number, tier: QualityTier = 'high'): Birds {
  const rng = fork(seed, 'birds');
  let mix: readonly [number, number, number] = [0.5, 0.35, 0.15];
  const group = new THREE.Group();
  const time = { value: 0 };
  const flap = { value: 1 };
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => { patchBirdShader(shader, time, flap); };

  const geometries: THREE.BufferGeometry[] = [];
  // meshes[species][lod]
  const meshes = SPECIES.map((species) =>
    ([0, 1, 2] as const).map((level) => {
      const geometry = buildBird(species, level);
      const flapAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BIRDS * 3), 3);
      flapAttr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aFlap', flapAttr);
      geometries.push(geometry);
      const mesh = new THREE.InstancedMesh(geometry, material, MAX_BIRDS);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances move far from the geometry's own bounds.
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      group.add(mesh);
      return { mesh, flapAttr };
    }),
  );

  const birds: Bird[] = [];
  for (let i = 0; i < MAX_BIRDS; i++) {
    const roll = rng();
    const species = speciesFor(roll, mix);
    const size = 0.9 + rng() * 0.3;
    const heading = rng() * Math.PI * 2;
    const speed = item(SPECIES, species).speed;
    const tint = new THREE.Color().setScalar(0.92 + rng() * 0.08);
    birds.push({
      roll,
      x: 0, y: 0, z: 0,
      vx: Math.sin(heading) * speed, vy: 0, vz: Math.cos(heading) * speed,
      group: species,
      size,
      phase: rng() * Math.PI * 2,
      heading,
      bank: 0,
      lod: 0,
      tint,
      fade: 0,
    });
  }
  // One leader per species circles the flock centre at its own radius and height.
  const orbits = SPECIES.map((species, index) => ({
    radius: 45 + rng() * 30 + index * 20,
    height: 14 + rng() * 8 + index * 5,
    omega: (species.speed / (60 + index * 20)) * (rng() < 0.5 ? -1 : 1),
    phase: rng() * Math.PI * 2,
  }));
  const leaders: Leader[] = orbits.map(() => ({ x: 0, y: 0, z: 0 }));
  // Where each species' flock circles, and whether it is in the sky now.
  const flocks = SPECIES.map(() => ({ x: 0, z: 0, present: false, wait: 0 }));
  const flockRng = fork(seed, 7001);
  const span = (range: readonly [number, number]): number => range[0] + (range[1] - range[0]) * flockRng();
  const whale = { x: 0, z: 0, dx: 0, dz: -1, set: false };
  const speeds = SPECIES.map((species) => species.speed);

  let active = detailFor(tier).birds;
  const live: Bird[] = [];
  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';
  const counts = SPECIES.map(() => [0, 0, 0]);
  let draws = 0;
  let triangles = 0;
  const trianglesOf = meshes.map((row) => row.map(({ mesh }) => triangleCount(mesh.geometry)));

  return {
    group,
    update(t, centerX = 0, centerZ = 0, dt = 0, camera, calm = false) {
      time.value = t;
      flap.value = calm ? 0 : 1;
      const first = !whale.set;
      const step = Math.min(dt, 0.1);
      if (first) {
        whale.x = centerX;
        whale.z = centerZ;
        whale.set = true;
      } else if (step > 0) {
        // The course is read from the whale's motion; a standstill keeps the last one, a jump starts the flocks afresh.
        const mx = centerX - whale.x;
        const mz = centerZ - whale.z;
        const moved = Math.hypot(mx, mz);
        if (moved / step > 1) {
          whale.dx = mx / moved;
          whale.dz = mz / moved;
        }
        if (moved > 250) flocks.forEach((flock) => (flock.present = false));
        whale.x = centerX;
        whale.z = centerZ;
      }
      flocks.forEach((flock, i) => {
        const behind = (whale.x - flock.x) * whale.dx + (whale.z - flock.z) * whale.dz;
        if (flock.present && (behind > GONE_BEHIND || Math.hypot(whale.x - flock.x, whale.z - flock.z) > AHEAD[1] * 1.6)) {
          flock.present = false;
          flock.wait = span(PAUSE);
        }
        // Away: once its birds have faded and the pause is over, it comes in ahead, on alternate sides.
        let gone = true;
        for (const bird of birds) if (bird.group === i && bird.fade > 0) gone = false;
        if (!flock.present) {
          flock.wait -= step;
          if (flock.wait <= 0 && gone) {
            const ahead = first ? 140 : span(AHEAD);
            const side = (flockRng() < 0.5 ? -1 : 1) * span(ABEAM);
            flock.x = whale.x + whale.dx * ahead - whale.dz * side;
            flock.z = whale.z + whale.dz * ahead + whale.dx * side;
            flock.present = true;
          }
        }
      });
      orbits.forEach((orbit, i) => {
        const a = t * orbit.omega + orbit.phase;
        const leader = item(leaders, i);
        leader.x = item(flocks, i).x + Math.cos(a) * orbit.radius;
        leader.z = item(flocks, i).z + Math.sin(a) * orbit.radius;
        leader.y = orbit.height + Math.sin(a * 2.3) * 3;
      });
      const place = (bird: Bird, index: number) => {
        const leader = item(leaders, bird.group);
        const around = (index / MAX_BIRDS) * Math.PI * 2;
        bird.x = leader.x + Math.cos(around) * 12;
        bird.z = leader.z + Math.sin(around) * 12;
        bird.y = leader.y + (index % 3) * 2;
      };
      live.length = 0;
      birds.forEach((bird, i) => {
        // A bird whose species the region no longer wants fades out, changes unseen and returns.
        const wanted = speciesFor(bird.roll, mix);
        if (bird.fade === 0) bird.group = wanted;
        const target = i < active && bird.group === wanted && item(flocks, bird.group).present ? 1 : 0;
        if (first) {
          // Spread a fresh flock around its leader on first sight.
          place(bird, i);
          bird.fade = target;
        } else if (bird.fade !== target) {
          // A bird that returns after a tier change joins its leader again rather than from where it left.
          if (bird.fade === 0) place(bird, i);
          const move = step / FADE_SECONDS;
          bird.fade = target > bird.fade ? Math.min(1, bird.fade + move) : Math.max(0, bird.fade - move);
        }
        if (bird.fade > 0) live.push(bird);
      });
      stepFlock(live, leaders, { speeds, minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }, step);

      for (const row of counts) row.fill(0);
      for (const row of meshes) for (const { mesh } of row) mesh.count = 0;
      for (const bird of live) {
        const species = bird.group;
        const heading = Math.atan2(bird.vx, bird.vz);
        let turn = heading - bird.heading;
        if (turn > Math.PI) turn -= Math.PI * 2;
        else if (turn < -Math.PI) turn += Math.PI * 2;
        bird.heading = heading;
        const targetBank = step > 0 ? Math.max(-0.5, Math.min(0.5, (turn / step) * -1.2)) : 0;
        bird.bank = damp(bird.bank, targetBank, 2, step);
        const distance = camera ? Math.hypot(bird.x - camera.x, bird.y - camera.y, bird.z - camera.z) : 0;
        bird.lod = selectLod(bird.lod, distance, LOD_BOUNDS);

        const { mesh, flapAttr } = item(item(meshes, species), bird.lod);
        const filled = item(counts, species);
        const slot = filled[bird.lod] ?? 0;
        filled[bird.lod] = slot + 1;
        const horizontal = Math.hypot(bird.vx, bird.vz);
        dummy.position.set(bird.x, bird.y, bird.z);
        dummy.rotation.set(-Math.atan2(bird.vy, horizontal), heading, bird.bank);
        const scale = bird.size * bird.fade;
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
        mesh.setColorAt(slot, bird.tint);
        const sp = item(SPECIES, species);
        flapAttr.setXYZ(slot, bird.phase, sp.rate * (0.9 + bird.size * 0.1), sp.glide);
        mesh.count = slot + 1;
      }
      draws = 0;
      triangles = 0;
      meshes.forEach((row, s) => { row.forEach(({ mesh, flapAttr }, l) => {
          const n = item(counts, s)[l] ?? 0;
          mesh.visible = n > 0;
          if (n > 0) {
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            flapAttr.needsUpdate = true;
            draws++;
            triangles += n * (item(trianglesOf, s)[l] ?? 0);
          }
        }); },
      );
    },
    setTier(next) {
      active = detailFor(next).birds;
    },
    setMix(next) {
      mix = next;
    },
    stats() {
      return { birds: active, draws, triangles };
    },
    dispose() {
      for (const g of geometries) g.dispose();
      material.dispose();
      for (const row of meshes) for (const { mesh } of row) mesh.dispose();
    },
  };
}
