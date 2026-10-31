import * as THREE from 'three';
import { FISH_SPECIES, type FishShape, type FishSpecies } from './fish-species.js';
import { hash } from './rng.js';
import { absorb } from './underwater-life.js';

/**
 * Fish built at unit length (nose toward +x) and swum entirely in the vertex
 * shader, after the instanced swim of ABZU (Nava, GDC 2017): a side-to-side
 * shift, a yaw about the head and a spine wave running to the tail, each from
 * a per-instance phase and rate. Rays flap their wing tips; jellyfish pulse.
 * The swim reads only `uTime`, so a held clock holds every fish still.
 */

export type FishLevel = 0 | 1 | 2;

/** Detail per level: body rings and sides (fish), grid cells (ray), bell rows and segments (jelly). */
type Detail = readonly [number, number];
const LEVELS: Record<FishShape, readonly [Detail, Detail, Detail]> = {
  fish: [[7, 6], [4, 4], [2, 3]],
  ray: [[5, 6], [3, 4], [2, 2]],
  jelly: [[4, 8], [3, 6], [2, 4]],
};

type Point = readonly [number, number, number];

/** Build one species at one level of detail as flat-shaded triangles with back-to-belly vertex colours. */
export function buildFish(species: FishSpecies, level: FishLevel): THREE.BufferGeometry {
  const [a, b] = LEVELS[species.shape][level];
  const position: number[] = [];
  const color: number[] = [];
  const back = new THREE.Color(species.back);
  const belly = new THREE.Color(species.belly);
  const c = new THREE.Color();
  const same = (p: Point, q: Point) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
  // Shade runs from belly to back over the middle of the body's height. Triangles collapsed at a tip are dropped.
  const tri = (...points: [Point, Point, Point]) => {
    if (same(points[0], points[1]) || same(points[1], points[2]) || same(points[0], points[2])) return;
    for (const p of points) {
      position.push(p[0], p[1], p[2]);
      c.lerpColors(belly, back, THREE.MathUtils.smoothstep(p[1], -0.04, 0.04));
      color.push(c.r, c.g, c.b);
    }
  };
  const quad = (p: Point, q: Point, r: Point, s: Point) => {
    tri(p, q, r);
    tri(r, q, s);
  };

  if (species.shape === 'fish') {
    // A lathe from the nose (t = 0, x = 0.5) to the peduncle (t = 1, x = -0.3): blunt head, widest a third back.
    const radius = (t: number) => (Math.sqrt(t) * (1 - t)) / 0.385;
    const ring = (i: number, s: number): Point => {
      const t = i / (a + 1);
      const angle = (s / b) * Math.PI * 2;
      const r = radius(t);
      return [0.5 - 0.8 * t, (Math.cos(angle) * r * species.height) / 2, (Math.sin(angle) * r * species.width) / 2];
    };
    for (let i = 0; i <= a; i++) for (let s = 0; s < b; s++) quad(ring(i, s), ring(i, s + 1), ring(i + 1, s), ring(i + 1, s + 1));
    // Forked tail fin, and a dorsal fin above the widest point on the finer levels.
    const h = species.height;
    tri([-0.27, 0, 0], [-0.5, 0.6 * h, 0], [-0.4, 0, 0]);
    tri([-0.27, 0, 0], [-0.4, 0, 0], [-0.5, -0.6 * h, 0]);
    if (level < 2) tri([0.15, h / 2, 0], [-0.05, h * 0.85, 0], [-0.08, h * 0.45, 0]);
  } else if (species.shape === 'ray') {
    // A diamond disc (span ±0.5 in z), domed on top and flat below, and a whip tail.
    const point = (u: number, v: number, side: 1 | -1): Point => {
      const span = 0.5 * (u < 0.35 ? u / 0.35 : (1 - u) / 0.65) ** 0.7;
      const dome = species.height * (1 - v * v) * Math.sin(Math.PI * u);
      return [0.3 - 0.55 * u, side > 0 ? dome / 2 : -dome / 4, v * span];
    };
    for (const side of [1, -1] as const) {
      for (let i = 0; i < a; i++) {
        for (let j = 0; j < b; j++) {
          const [u0, u1, v0, v1] = [i / a, (i + 1) / a, (2 * j) / b - 1, (2 * (j + 1)) / b - 1];
          if (side > 0) quad(point(u0, v0, side), point(u0, v1, side), point(u1, v0, side), point(u1, v1, side));
          else quad(point(u0, v1, side), point(u0, v0, side), point(u1, v1, side), point(u1, v0, side));
        }
      }
    }
    tri([-0.24, 0, -0.015], [-0.24, 0, 0.015], [-0.85, 0, 0]);
  } else {
    // A bell (rows down from the crown, radius 0.5) over trailing tentacles; y up.
    const bell = (row: number, s: number): Point => {
      const phi = (row / a) * Math.PI * 0.5;
      const angle = (s / b) * Math.PI * 2;
      return [Math.sin(phi) * Math.cos(angle) * 0.5, Math.cos(phi) * species.height, Math.sin(phi) * Math.sin(angle) * 0.5];
    };
    for (let row = 0; row < a; row++) for (let s = 0; s < b; s++) quad(bell(row, s), bell(row, s + 1), bell(row + 1, s), bell(row + 1, s + 1));
    for (let k = 0; k < b / 2; k++) {
      const angle = (k / (b / 2)) * Math.PI * 2;
      const [x, z] = [Math.cos(angle) * 0.3, Math.sin(angle) * 0.3];
      for (let j = 0; j < a; j++) {
        const [y0, y1] = [-0.05 - (j / a) * 1.3, -0.05 - ((j + 1) / a) * 1.3];
        quad([x - 0.03, y0, z], [x + 0.03, y0, z], [x - 0.02, y1, z], [x + 0.02, y1, z]);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geometry.computeVertexNormals();
  return geometry;
}

const SWIM: Record<FishShape, string> = {
  fish: /* glsl */ `
    float swimT = 0.5 - position.x;
    // Spine wave from nose to tail, growing toward the tail; a yaw about the head; a side-to-side shift.
    transformed.z += 0.5 * uSway * swimT * swimT * sin( swimW - 5.0 * swimT );
    transformed.z += 0.2 * uSway * ( position.x - 0.3 ) * sin( swimW + 1.2 ) + 0.08 * uSway * sin( swimW );`,
  ray: /* glsl */ `
    float swimT = 0.3 - position.x;
    // Wing tips lift and fall in a wave from front to back; the tail trails.
    transformed.y += uSway * pow( abs( position.z ) * 2.0, 1.5 ) * sin( swimW - 2.5 * swimT );
    transformed.z += 0.06 * max( swimT - 0.55, 0.0 ) * sin( swimW * 0.7 );`,
  jelly: /* glsl */ `
    // A quick squeeze of the bell and a slow relax; the tentacles drift behind.
    float swimP = pow( 0.5 + 0.5 * sin( swimW ), 3.0 );
    float swimBell = step( 0.0, position.y );
    transformed.xz *= 1.0 - uSway * swimP * swimBell;
    transformed.y *= 1.0 + 0.5 * uSway * swimP * swimBell;
    transformed.xz += ( 1.0 - swimBell ) * 0.05 * -position.y * vec2( sin( swimW * 0.5 + position.y * 3.0 ), cos( swimW * 0.4 + position.y * 2.0 ) );`,
};

/** Shader additions: the swim from an instanced phase and rate (`aSwim`), and a glow added after the depth absorption. */
export function patchFishShader(shader: THREE.WebGLProgramParametersWithUniforms, species: FishSpecies, time: THREE.IUniform<number>): void {
  shader.uniforms['uTime'] = time;
  shader.uniforms['uBeat'] = { value: species.beat };
  shader.uniforms['uSway'] = { value: species.sway };
  shader.uniforms['uGlow'] = { value: new THREE.Color(species.glowColor).multiplyScalar(species.glow) };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aSwim;\nuniform float uTime;\nuniform float uBeat;\nuniform float uSway;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>\nfloat swimW = 6.2831853 * uBeat * aSwim.y * uTime + aSwim.x;${SWIM[species.shape]}`);
  absorb(shader);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uGlow;')
    .replace('#include <opaque_fragment>', 'outgoingLight += uGlow;\n#include <opaque_fragment>');
}

/** An instanced school of one species at one level; each slot gets a seeded swim phase and a rate near 1. */
export function createFishMesh(species: FishSpecies, level: FishLevel, capacity: number, time: THREE.IUniform<number>): THREE.InstancedMesh {
  const geometry = buildFish(species, level);
  const swim = new Float32Array(capacity * 2);
  for (let i = 0; i < capacity; i++) {
    swim[i * 2] = (hash(0x4657, i, 1) / 0x100000000) * Math.PI * 2;
    swim[i * 2 + 1] = 0.85 + 0.3 * (hash(0x4657, i, 2) / 0x100000000);
  }
  geometry.setAttribute('aSwim', new THREE.InstancedBufferAttribute(swim, 2));
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => { patchFishShader(shader, species, time); };
  material.customProgramCacheKey = () => `fish-${species.shape}`;
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = `fish-${species.name}-${String(level)}`;
  return mesh;
}

/** Review only: a small school of every species, side by side in two rows, held broadside 14 m ahead of the camera. */
export function createFishShowcase(time: THREE.IUniform<number>, layer: number): { group: THREE.Group; follow: (camera: THREE.Camera) => void; dispose: () => void } {
  const group = new THREE.Group();
  group.name = 'fish-showcase';
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  FISH_SPECIES.forEach((species, i) => {
    const count = Math.min(40, Math.max(3, species.school[0]));
    const mesh = createFishMesh(species, 0, count, time);
    const cell = Math.max(2.5, species.length * 3);
    for (let k = 0; k < count; k++) {
      const r = (n: number) => hash(0x4653, i, k, n) / 0x100000000 - 0.5;
      euler.set(0, r(4) * 0.4, r(5) * 0.2);
      const at = new THREE.Vector3(r(1) * cell, r(2) * cell * 0.4, r(3) * cell * 0.5);
      mesh.setMatrixAt(k, matrix.compose(at, quat.setFromEuler(euler), new THREE.Vector3().setScalar(species.length)));
    }
    mesh.position.set(((i % 4) - 1.5) * 4.5, i < 4 ? 2 : -2, 0);
    mesh.frustumCulled = false;
    mesh.layers.set(layer);
    group.add(mesh);
  });
  const ahead = new THREE.Vector3();
  return {
    group,
    follow(camera) {
      camera.getWorldDirection(ahead);
      group.position.copy(camera.position).addScaledVector(ahead, 14);
      group.rotation.set(0, Math.atan2(ahead.x, ahead.z), 0);
    },
    dispose() {
      for (const mesh of group.children as THREE.InstancedMesh[]) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        mesh.dispose();
      }
    },
  };
}
