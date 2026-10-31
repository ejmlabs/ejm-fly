import * as THREE from 'three';
import { box, shape } from './land-objects.js';
import { WALKER } from './land-life.js';
import { landShadingGLSL, type LandStream } from './landmesh.js';
import { WALKER_STRIDE } from './world-tiles.js';
import { item } from './item.js';
import { DRAW_AS_AUTHORED_GLSL } from './tone.js';

/**
 * People and animals on the land: one instanced draw for people and one for
 * animals, filled from the walkers of the land tiles drawn now, nearest first
 * up to the tier's cap. They pace and graze in the vertex shader on their own
 * clock, which stands still under reduced motion. They are lit and hazed like
 * the land, and kept out of the water's mirror (layer 1): they are too small
 * to reflect.
 */
export interface Walkers {
  group: THREE.Group;
  /** Refills the instances when the drawn tiles change; `clock` drives the animation. */
  update: (cameraX: number, cameraZ: number, clock: number) => void;
  setCap: (cap: number) => void;
  /** The people's and animals' materials, to compile ahead of their first draw. */
  materials: readonly THREE.Material[];
  stats: () => { walkers: number; draws: number; triangles: number };
  dispose: () => void;
}

/** Vertex tags: 1 and 2 are the two legs (or leg pairs), 3 the head; +10 takes the instance's tint. */
const TINTED = 10;

const linear = (hex: number): [number, number, number] => {
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};

const WHITE = [1, 1, 1] as const;

function personMesh(): THREE.BufferGeometry {
  const trousers = linear(0x3a3d46);
  return shape([
    box(0.15, 0.86, 0.18, 0, { color: trousers, tag: 1, x: -0.1 }),
    box(0.15, 0.86, 0.18, 0, { color: trousers, tag: 2, x: 0.1 }),
    box(0.44, 0.66, 0.26, 0.84, { color: WHITE, tag: TINTED }),
    box(0.22, 0.25, 0.22, 1.5, { color: linear(0xc69c7c) }),
  ]);
}

function animalMesh(): THREE.BufferGeometry {
  const hooves = linear(0x2e2925);
  return shape([
    box(0.42, 0.5, 0.13, 0, { color: hooves, tag: 1, z: 0.36 }),
    box(0.42, 0.5, 0.13, 0, { color: hooves, tag: 2, z: -0.36 }),
    box(0.5, 0.56, 1.1, 0.46, { color: WHITE, tag: TINTED }),
    box(0.26, 0.3, 0.36, 0.74, { color: WHITE, tag: TINTED + 3, z: 0.66 }),
  ]);
}

/** Per kind: size, pace (m/s) and coat or clothes colours (sRGB hex). */
const LOOKS: Record<number, { scale: number; speed: number; tints: number[] }> = {
  [WALKER.person]: { scale: 1.1, speed: 1.2, tints: [0x8a3b32, 0x34507a, 0x4a6a3a, 0xc9a24a, 0xe6e0d4, 0x5a5560] },
  [WALKER.sheep]: { scale: 1, speed: 0.12, tints: [0xe6e1d6, 0xd8d1c2, 0x3b3532] },
  [WALKER.cow]: { scale: 1.55, speed: 0.1, tints: [0x6b4a34, 0x2f2a28, 0xe4ddd0] },
  [WALKER.deer]: { scale: 1.25, speed: 0.15, tints: [0x9a6e46, 0x8a5f3c, 0xa47a50] },
  [WALKER.reindeer]: { scale: 1.3, speed: 0.12, tints: [0x8f7f6c, 0x6e6152, 0xcfc8bc] },
  [WALKER.goat]: { scale: 0.9, speed: 0.14, tints: [0xd8d0c0, 0x7a6450, 0x4a3f36] },
};

const vertexShader = (animal: boolean) => /* glsl */ `
attribute float tag;
attribute vec4 spot;
attribute vec4 motion;
attribute vec3 tint;
uniform float clock;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  float part = mod( tag, 10.0 );
  vColor = tag > 9.5 ? tint * ( part > 2.5 ? 0.8 : 1.0 ) : color;
  // Pacing to and fro along the heading (spot.w), motion = (phase, range, speed, scale).
  float t = clock * motion.z / max( motion.y, 0.5 ) + motion.x;
  float moving = motion.y > 0.01 ? abs( cos( t ) ) : 0.0;
  vec3 p = position;
  float stride = sin( clock * ${animal ? '5.0' : '7.5'} + motion.x * 7.0 ) * moving;
  float lower = 1.0 - clamp( p.y / ${animal ? '0.5' : '0.86'}, 0.0, 1.0 );
  if ( part > 0.5 && part < 2.5 ) p.z += ( part < 1.5 ? 1.0 : -1.0 ) * stride * ${animal ? '0.12' : '0.22'} * lower;
  ${
    animal
      ? `// Grazing: the head dips to the grass now and then.
  float graze = smoothstep( 0.35, 0.85, sin( clock * 0.33 + motion.x * 3.0 ) * 0.5 + 0.5 );
  if ( part > 2.5 ) { p.y -= graze * 0.42; p.z += graze * 0.1; }
  float facing = spot.w;`
      : `p.y += 0.045 * abs( stride );
  float facing = spot.w + ( cos( t ) < 0.0 ? 3.14159265 : 0.0 );`
  }
  float c = cos( facing );
  float s = sin( facing );
  p *= motion.w;
  vec3 turned = vec3( p.x * c + p.z * s, p.y, p.z * c - p.x * s );
  vNormal = vec3( normal.x * c + normal.z * s, normal.y, normal.z * c - normal.x * s );
  vec3 local = spot.xyz + turned + vec3( sin( spot.w ), 0.0, cos( spot.w ) ) * motion.y * sin( t );
  vec4 world = modelMatrix * vec4( local, 1.0 );
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const fragmentShader = (stops: number) => /* glsl */ `
${landShadingGLSL(stops)}
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  gl_FragColor = vec4( landShade( vColor, normalize( vNormal ), vWorld ), 1.0 );
  ${DRAW_AS_AUTHORED_GLSL}
}`;

/** Instances are re-sorted by distance once the camera has moved this far. */
const RESORT = 120;

export function createWalkers(stream: LandStream, initialCap: number): Walkers {
  const group = new THREE.Group();
  group.name = 'walkers';
  const clock = { value: 0 };
  let cap = initialCap;
  const kinds = [false, true].map((animal) => {
    const base = animal ? animalMesh() : personMesh();
    const geometry = new THREE.InstancedBufferGeometry();
    for (const name of ['position', 'normal', 'color', 'tag']) geometry.setAttribute(name, base.getAttribute(name));
    const material = new THREE.ShaderMaterial({
      vertexShader: vertexShader(animal),
      fragmentShader: fragmentShader(stream.hazeStops),
      uniforms: { ...stream.uniforms, clock },
      vertexColors: true,
      fog: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.layers.set(1);
    mesh.visible = false;
    group.add(mesh);
    return { geometry, material, mesh, triangles: geometry.getAttribute('position').count / 3, count: 0 };
  });

  function allocate(size: number): void {
    for (const kind of kinds) {
      const g = kind.geometry;
      g.setAttribute('spot', new THREE.InstancedBufferAttribute(new Float32Array(size * 4), 4));
      g.setAttribute('motion', new THREE.InstancedBufferAttribute(new Float32Array(size * 4), 4));
      g.setAttribute('tint', new THREE.InstancedBufferAttribute(new Float32Array(size * 3), 3));
    }
  }
  allocate(cap);

  let version = -1;
  let sortedAt = { x: Infinity, z: Infinity };

  function refill(cameraX: number, cameraZ: number): void {
    const tiles = stream.walkerTiles();
    // Nearest tiles first, so the cap drops the farthest walkers.
    const order = tiles
      .map((tile) => ({ tile, d: Math.hypot(tile.x0 - cameraX, tile.z0 - cameraZ) + tile.level * 1e-3 }))
      .sort((a, b) => a.d - b.d);
    const ax = Math.round(cameraX / 64) * 64;
    const az = Math.round(cameraZ / 64) * 64;
    for (const kind of kinds) kind.count = 0;
    let total = 0;
    for (const { tile } of order) {
      const data = tile.data;
      for (let r = 0; r + WALKER_STRIDE <= data.length && total < cap; r += WALKER_STRIDE) {
        const look = item(LOOKS, data[r] ?? 0);
        const kind = item(kinds, (data[r] ?? 0) === WALKER.person ? 0 : 1);
        const n = kind.count++;
        total++;
        const g = kind.geometry;
        (g.getAttribute('spot') as THREE.InstancedBufferAttribute).setXYZW(n, tile.x0 + (data[r + 1] ?? 0) - ax, data[r + 2] ?? 0, tile.z0 + (data[r + 3] ?? 0) - az, data[r + 4] ?? 0);
        (g.getAttribute('motion') as THREE.InstancedBufferAttribute).setXYZW(n, data[r + 6] ?? 0, data[r + 5] ?? 0, look.speed, look.scale);
        const [cr, cg, cb] = linear(look.tints[(data[r + 7] ?? 0) % look.tints.length] ?? 0);
        (g.getAttribute('tint') as THREE.InstancedBufferAttribute).setXYZ(n, cr, cg, cb);
      }
    }
    for (const kind of kinds) {
      const g = kind.geometry;
      for (const name of ['spot', 'motion', 'tint']) (g.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
      g.instanceCount = kind.count;
      kind.mesh.visible = kind.count > 0;
      kind.mesh.position.set(ax, 0, az);
    }
    sortedAt = { x: cameraX, z: cameraZ };
  }

  return {
    group,
    materials: kinds.map((kind) => kind.material),
    update(cameraX, cameraZ, time) {
      clock.value = time;
      const next = stream.walkerVersion();
      if (next !== version || Math.hypot(cameraX - sortedAt.x, cameraZ - sortedAt.z) > RESORT) {
        version = next;
        refill(cameraX, cameraZ);
      }
    },
    setCap(next) {
      if (next === cap) return;
      cap = next;
      allocate(cap);
      version = -1;
    },
    stats() {
      let walkers = 0;
      let draws = 0;
      let triangles = 0;
      for (const kind of kinds) {
        walkers += kind.count;
        if (kind.count) draws++;
        triangles += kind.count * kind.triangles;
      }
      return { walkers, draws, triangles };
    },
    dispose() {
      for (const kind of kinds) {
        kind.geometry.dispose();
        kind.material.dispose();
      }
    },
  };
}
