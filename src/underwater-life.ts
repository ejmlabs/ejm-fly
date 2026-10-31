import * as THREE from 'three';
import type { QualityTier } from './quality.js';
import type { FloatingOrigin } from './seams.js';
import { hash } from './rng.js';
import { makeNoise2D } from './noise.js';
import { clamp, smoothstep } from './math.js';
import { cellDistance, chunksAround, createChunkStreamer, parseChunkKey, type ChunkStreamer } from './chunks.js';
import { GLSL_SCENERY } from './underwater-glsl.js';
import { item } from './item.js';

/**
 * Seafloor life streamed in world cells around the camera: kelp, seagrass,
 * rocks and coral as instanced meshes, and fish schools whose motion runs
 * entirely in the vertex shader. Each cell's content is a pure function of
 * (seed, cell, floor), so it never depends on visit order. Instances grow in
 * at the edge of the streamed radius (deep in the fog) and shrink away near
 * the camera and between the camera and the whale.
 */

export const LIFE_CELL = 24;
export const SCHOOL_CELL = 160;
/** Numeric salts (string salts all hash alike, see rng.ts). */
const LIFE_SALT = 0x4c46;
const SCHOOL_SALT = 0x5343;
/** Instances sit this far into the floor so their feet never float over the patch. */
const FOOT_SINK = 0.12;

export type LifeKind = 'kelp' | 'grass' | 'rock';

export interface LifeInstance {
  kind: LifeKind;
  /** World foot position. */
  x: number;
  y: number;
  z: number;
  /** Width scale, and the extent upward in metres. */
  width: number;
  height: number;
  yaw: number;
  phase: number;
  /** 0 plain rock, otherwise a coral tint index 1..3. */
  tint: number;
}

export interface School { id: number; x: number; y: number; z: number; loop: number; speed: number; phase: number; spread: number }

type Floor = (x: number, z: number) => number;

const TIER = {
  low: { candidates: 14, radius: 58, schools: 4, fish: 26, builds: 2 },
  medium: { candidates: 22, radius: 66, schools: 5, fish: 40, builds: 3 },
  high: { candidates: 30, radius: 72, schools: 6, fish: 56, builds: 4 },
} as const;

/** Habitat patches (kelp forests, meadows) vary slowly across the floor, seeded per world. */
export function createHabitat(seed: number): (x: number, z: number) => number {
  const noise = makeNoise2D(hash(seed, LIFE_SALT), 7);
  return (x, z) => noise(x / 90, z / 90);
}

/**
 * Life in one cell. `candidates` caps how many sites are tried (tier density);
 * the first candidates are the same at every tier, so lower tiers are subsets.
 */
export function lifeInCell(seed: number, cx: number, cz: number, floorAt: Floor, habitat: (x: number, z: number) => number, candidates: number): LifeInstance[] {
  const out: LifeInstance[] = [];
  for (let i = 0; i < candidates; i++) {
    const r = (k: number) => hash(seed, LIFE_SALT, cx, cz, i, k) / 0x100000000;
    const x = (cx + r(1)) * LIFE_CELL;
    const z = (cz + r(2)) * LIFE_CELL;
    const h = floorAt(x, z);
    const depth = -h;
    if (!(depth > 2.5)) continue;
    const slope = Math.hypot(floorAt(x + 1.5, z) - h, floorAt(x, z + 1.5) - h) / 1.5;
    const patch = habitat(x, z);
    const roll = r(3);
    const base = { x, y: h - FOOT_SINK, z, yaw: r(4) * Math.PI * 2, phase: r(5) * 100, tint: 0 };
    if (depth > 5 && depth < 32 && patch > 0.1 && slope < 0.8 && roll < 0.2 + 0.5 * patch) {
      // Kelp stands up from the floor but always ends a metre and a half under the surface.
      const height = Math.min(depth - 1.5, 5 + 13 * r(6));
      out.push({ ...base, kind: 'kelp', width: 0.8 + 0.6 * r(7), height });
    } else if (depth < 18 && slope < 0.3 && patch < 0.45 && roll < 0.75) {
      out.push({ ...base, kind: 'grass', width: 0.8 + 0.7 * r(7), height: 0.5 + 0.7 * r(6) });
    } else if (roll < 0.14 + 0.5 * smoothstep(0.25, 0.8, slope)) {
      const size = 0.4 + 1.6 * r(6) * r(6);
      const coral = depth < 16 && r(8) < 0.45;
      out.push({ ...base, kind: 'rock', width: size, height: size * (coral ? 0.8 : 0.55), tint: coral ? 1 + Math.floor(r(9) * 3) : 0 });
    }
  }
  return out;
}

/** A fish school in a cell, or null. Schools loop around a fixed world centre clear of floor and surface. */
export function schoolInCell(seed: number, cx: number, cz: number, floorAt: Floor): School | null {
  const r = (k: number) => hash(seed, SCHOOL_SALT, cx, cz, k) / 0x100000000;
  if (r(0) > 0.65) return null;
  const x = (cx + 0.2 + 0.6 * r(1)) * SCHOOL_CELL;
  const z = (cz + 0.2 + 0.6 * r(2)) * SCHOOL_CELL;
  const floor = floorAt(x, z);
  const spread = 1.8 + 1.8 * r(6);
  // Needs room for the school's spread above the floor and below the surface.
  if (!(floor < -(2 * spread + 8))) return null;
  const y = clamp(-4 - 10 * r(3), floor + spread + 3, -spread - 2.5);
  return { id: hash(seed, SCHOOL_SALT, cx, cz), x, y, z, loop: 8 + 14 * r(4), speed: (0.08 + 0.06 * r(5)) * (r(7) < 0.5 ? -1 : 1), phase: r(8) * Math.PI * 2, spread };
}

/** TS mirror of GLSL sceneryFade: 0 hides an instance, 1 shows it in full. */
export function sceneryFade(
  base: { x: number; y: number; z: number },
  height: number,
  cam: { x: number; y: number; z: number },
  whale: { x: number; y: number; z: number },
  far: number,
): number {
  const abx = whale.x - cam.x;
  const aby = whale.y - cam.y;
  const abz = whale.z - cam.z;
  const t = clamp(((base.x - cam.x) * abx + (base.z - cam.z) * abz) / Math.max(abx * abx + abz * abz, 1e-4), 0, 1);
  const px = base.x;
  const py = clamp(cam.y + aby * t, base.y, base.y + height);
  const pz = base.z;
  const s = clamp(((px - cam.x) * abx + (py - cam.y) * aby + (pz - cam.z) * abz) / Math.max(abx * abx + aby * aby + abz * abz, 1e-4), 0, 1);
  const line = Math.hypot(px - (cam.x + abx * s), py - (cam.y + aby * s), pz - (cam.z + abz * s));
  const corridor = smoothstep(2, 4.5, line);
  const near = smoothstep(4, 7, Math.hypot(px - cam.x, py - cam.y, pz - cam.z));
  const edge = 1 - smoothstep(far - 14, far - 2, Math.hypot(base.x - cam.x, base.z - cam.z));
  return corridor * near * edge;
}

/* ---------------------------------------------------------------- geometry */

/** A tapering ribbon, two crossed so it reads from every side; y runs 0..1. */
function kelpGeometry(): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(0.45, 1, 1, 8).translate(0, 0.5, 0);
  const pos = a.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    // Blades widen above the holdfast and thin to a tip.
    pos.setX(i, pos.getX(i) * (0.35 + 1.4 * Math.sin(Math.PI * Math.min(1, y * 1.05)) ** 0.7));
  }
  const b = a.clone().rotateY(Math.PI / 3);
  const c = a.clone().rotateY((2 * Math.PI) / 3).translate(0.12, 0, 0.08);
  return mergeGeometries([a, b, c]);
}

/** A clump of thin blades, y runs 0..1. */
function grassGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const r = (k: number) => hash(0x4752, i, k) / 0x100000000;
    const blade = new THREE.PlaneGeometry(0.06, 0.6 + 0.4 * r(1), 1, 2).translate(0, 0.3 + 0.2 * r(1), 0);
    const pos = blade.getAttribute('position') as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) pos.setX(v, pos.getX(v) * (1 - pos.getY(v)));
    blade.rotateZ((r(2) - 0.5) * 0.5).rotateY(r(3) * Math.PI).translate((r(4) - 0.5) * 0.5, 0, (r(5) - 0.5) * 0.5);
    parts.push(blade);
  }
  return mergeGeometries(parts);
}

/** A lumpy unit boulder sitting on y = 0. */
function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    const k = 0.78 + 0.32 * (hash(0x524b, Math.round(v.x * 40), Math.round(v.y * 40), Math.round(v.z * 40)) / 0x100000000);
    pos.setXYZ(i, v.x * k, Math.max(-0.25, v.y * k) + 0.25, v.z * k);
  }
  g.computeVertexNormals();
  return g;
}

/** A small fish along +X, nose at x = 0.2. */
function fishGeometry(): THREE.BufferGeometry {
  const v = [
    0.2, 0, 0, 0, 0.055, 0, 0, -0.045, 0, 0, 0, 0.028, 0, 0, -0.028, -0.16, 0, 0, -0.24, 0.06, 0, -0.24, -0.06, 0,
  ];
  const idx = [0, 1, 3, 0, 3, 2, 0, 4, 1, 0, 2, 4, 1, 5, 3, 3, 5, 2, 1, 4, 5, 4, 2, 5, 5, 6, 7];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  g.dispose();
  return flat;
}

function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let count = 0;
  const flat = parts.map((p) => {
    const f = p.index ? p.toNonIndexed() : p;
    count += f.getAttribute('position').count;
    return f;
  });
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  let offset = 0;
  for (const f of flat) {
    f.computeVertexNormals();
    position.set(f.getAttribute('position').array, offset);
    normal.set(f.getAttribute('normal').array, offset);
    offset += f.getAttribute('position').count * 3;
  }
  for (const p of parts) p.dispose();
  for (const f of flat) f.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  return g;
}

/* ---------------------------------------------------------------- materials */

/**
 * Light reaching seafloor life is weaker and bluer with depth (as on the floor
 * patch), so lit instances settle into the dark absorption fog instead of
 * glowing through it.
 */
export function absorb(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vLifeDepth;')
    .replace('#include <fog_vertex>', '#include <fog_vertex>\nvLifeDepth = max( 0.0, -( transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[3].xyz ) ).y );');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vLifeDepth;')
    .replace(
      '#include <opaque_fragment>',
      'outgoingLight *= 0.75 * exp( -0.035 * vLifeDepth ) * mix( vec3( 1.0 ), vec3( 0.55, 0.85, 0.9 ), 1.0 - exp( -vLifeDepth / 10.0 ) );\n#include <opaque_fragment>',
    );
}

interface Shared { uTime: THREE.IUniform<number>; uWhale: THREE.IUniform<THREE.Vector3>; uFar: THREE.IUniform<number> }

/** Lambert with the scenery fade, plus a current-driven sway that grows with height (`sway` metres at the top). */
function lifeMaterial(shared: Shared, color: number, sway: number, options: THREE.MeshLambertMaterialParameters = {}): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color, ...options });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\n${GLSL_SCENERY}`)
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        vec3 lifeFoot = instanceMatrix[3].xyz;
        float lifeHeight = length( instanceMatrix[1].xyz );
        vec4 mvPosition = instanceMatrix * vec4( transformed, 1.0 );
        float lifeSeed = lifeFoot.x * 0.37 + lifeFoot.z * 0.23;
        float lifeBend = pow( max( position.y, 0.0 ), 1.5 ) * ${sway.toFixed(2)};
        mvPosition.x += lifeBend * ( sin( uTime * 0.55 + lifeSeed ) + 0.35 * sin( uTime * 1.3 + lifeSeed * 2.1 + position.y * 3.0 ) );
        mvPosition.z += lifeBend * 0.6 * cos( uTime * 0.47 + lifeSeed * 1.7 );
        float lifeFade = sceneryFade( ( modelMatrix * vec4( lifeFoot, 1.0 ) ).xyz, lifeHeight );
        mvPosition.xyz = lifeFoot + ( mvPosition.xyz - lifeFoot ) * lifeFade;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
    absorb(shader);
  };
  material.customProgramCacheKey = () => `underwater-life-${String(sway)}`;
  return material;
}

/* ---------------------------------------------------------------- handle */

export interface UnderwaterLife {
  group: THREE.Group;
  /** Stream cells around the camera; `draw` false only warms caches. */
  update: (time: number, camWorldX: number, camWorldZ: number, whaleRender: THREE.Vector3, origin: FloatingOrigin, draw: boolean) => void;
  stats: () => { cells: number; instances: number; schools: number };
  dispose: () => void;
}

export function createUnderwaterLife(seed: number, floorAt: Floor, tierName: QualityTier, layer: number): UnderwaterLife {
  const tier = TIER[tierName];
  const habitat = createHabitat(seed);
  const shared: Shared = { uTime: { value: 0 }, uWhale: { value: new THREE.Vector3() }, uFar: { value: tier.radius } };
  const group = new THREE.Group();
  group.name = 'underwater-life';
  group.visible = false;

  const kinds = {
    kelp: { geometry: kelpGeometry(), material: lifeMaterial(shared, 0x6b6a2c, 0.9, { side: THREE.DoubleSide }), capacity: 900 },
    grass: { geometry: grassGeometry(), material: lifeMaterial(shared, 0x5e7a3a, 0.12, { side: THREE.DoubleSide }), capacity: 2600 },
    rock: { geometry: rockGeometry(), material: lifeMaterial(shared, 0xffffff, 0, { flatShading: true }), capacity: 900 },
  };
  const meshes = {} as Record<LifeKind, THREE.InstancedMesh>;
  for (const kind of ['kelp', 'grass', 'rock'] as const) {
    const k = kinds[kind];
    const mesh = new THREE.InstancedMesh(k.geometry, k.material, k.capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.layers.set(layer);
    mesh.name = `underwater-${kind}`;
    group.add(mesh);
    meshes[kind] = mesh;
  }
  // Rock greys and muted coral tints (display colours; three converts them).
  const tints = [0x5f645c, 0x9c6a60, 0xa3854f, 0x7a6286].map((hex) => new THREE.Color(hex));
  meshes.rock.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(kinds.rock.capacity * 3), 3);

  let dirty = false;
  const streamer: ChunkStreamer<LifeInstance[]> = createChunkStreamer({
    wanted: (wx, wz) => chunksAround(wx, wz, tier.radius, LIFE_CELL),
    keep: (key, wx, wz) => {
      const { cx, cz } = parseChunkKey(key);
      return cellDistance(wx, wz, cx, cz, LIFE_CELL) <= tier.radius + LIFE_CELL;
    },
    build: (key) => {
      const { cx, cz } = parseChunkKey(key);
      dirty = true;
      return lifeInCell(seed, cx, cz, floorAt, habitat, tier.candidates);
    },
    dispose: () => {
      dirty = true;
    },
    maxBuildsPerFrame: tier.builds,
  });

  /* fish */
  const fishBase = fishGeometry();
  const fishGeometryInst = new THREE.InstancedBufferGeometry();
  fishGeometryInst.setAttribute('position', fishBase.getAttribute('position'));
  fishGeometryInst.setAttribute('normal', fishBase.getAttribute('normal'));
  const fishCapacity = tier.schools * tier.fish;
  const aSchool = new THREE.InstancedBufferAttribute(new Float32Array(fishCapacity * 4), 4);
  const aLoop = new THREE.InstancedBufferAttribute(new Float32Array(fishCapacity * 4), 4);
  const aFish = new THREE.InstancedBufferAttribute(new Float32Array(fishCapacity * 4), 4);
  fishGeometryInst.setAttribute('aSchool', aSchool);
  fishGeometryInst.setAttribute('aLoop', aLoop);
  fishGeometryInst.setAttribute('aFish', aFish);
  fishGeometryInst.instanceCount = 0;
  const fishMaterial = new THREE.MeshLambertMaterial({ color: 0x7d929b, side: THREE.DoubleSide });
  fishMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uTime;
        attribute vec4 aSchool;
        attribute vec4 aLoop;
        attribute vec4 aFish;
        ${GLSL_SCENERY}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        // The school's centre loops a lazy, slightly bobbing ellipse; each fish holds a slot around it.
        float fishA = uTime * aLoop.x + aLoop.y;
        float fishR = aSchool.w;
        vec3 fishTangent = normalize( vec3( -sin( fishA ) * fishR, 0.3 * fishR * cos( 2.0 * fishA ) * 0.15, cos( fishA ) * fishR * 0.8 ) * sign( aLoop.x ) );
        vec3 fishSide = normalize( cross( fishTangent, vec3( 0.0, 1.0, 0.0 ) ) );
        vec3 fishUp = cross( fishSide, fishTangent );
        vec3 fishCentre = aSchool.xyz + vec3( cos( fishA ) * fishR, 0.15 * fishR * sin( 2.0 * fishA ), sin( fishA ) * fishR * 0.8 );
        vec3 fishSlot = aFish.xyz * aLoop.z;
        fishSlot += 0.35 * vec3( sin( uTime * 0.9 + aFish.w ), sin( uTime * 0.7 + aFish.w * 1.7 ) * 0.5, cos( uTime * 0.8 + aFish.w * 2.3 ) );
        vec3 fishPos = fishCentre + fishTangent * fishSlot.x + fishUp * fishSlot.y + fishSide * fishSlot.z;
        // Give way to the whale.
        vec3 fishWorld = ( modelMatrix * vec4( fishPos, 1.0 ) ).xyz;
        vec3 fishAway = fishWorld - uWhale;
        float fishGap = length( fishAway );
        fishPos += fishAway / max( fishGap, 1e-3 ) * 5.0 * ( 1.0 - smoothstep( 4.0, 11.0, fishGap ) );
        float fishFade = sceneryFade( ( modelMatrix * vec4( fishPos, 1.0 ) ).xyz, 0.0 );
        vec3 objectNormal = fishTangent * normal.x + fishUp * normal.y + fishSide * normal.z;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 fishLocal = position * 1.1;
        fishLocal.z += sin( uTime * 9.0 + aFish.w * 13.0 + fishLocal.x * 14.0 ) * 0.035 * ( 0.3 - fishLocal.x );
        vec3 transformed = fishPos + ( fishTangent * fishLocal.x + fishUp * fishLocal.y + fishSide * fishLocal.z ) * fishFade;`,
      );
    absorb(shader);
  };
  fishMaterial.customProgramCacheKey = () => 'underwater-fish';
  const fish = new THREE.Mesh(fishGeometryInst, fishMaterial);
  fish.frustumCulled = false;
  fish.layers.set(layer);
  fish.name = 'underwater-fish';
  group.add(fish);

  let schoolsDirty = false;
  const schools: ChunkStreamer<School | null> = createChunkStreamer({
    wanted: (wx, wz) => chunksAround(wx, wz, 150, SCHOOL_CELL),
    keep: (key, wx, wz) => {
      const { cx, cz } = parseChunkKey(key);
      return cellDistance(wx, wz, cx, cz, SCHOOL_CELL) <= 150 + SCHOOL_CELL;
    },
    build: (key) => {
      const { cx, cz } = parseChunkKey(key);
      schoolsDirty = true;
      return schoolInCell(seed, cx, cz, floorAt);
    },
    dispose: () => {
      schoolsDirty = true;
    },
    maxBuildsPerFrame: 1,
  });

  // Instances are written relative to an anchor (the origin when last rebuilt) so matrices stay small.
  let anchorX = 0;
  let anchorZ = 0;
  let instanceTotal = 0;
  let schoolTotal = 0;
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const vPos = new THREE.Vector3();
  const vScale = new THREE.Vector3();

  function rebuildLife(): void {
    const counts: Record<LifeKind, number> = { kelp: 0, grass: 0, rock: 0 };
    for (const cell of streamer.loaded.values()) {
      for (const inst of cell) {
        const mesh = meshes[inst.kind];
        const i = counts[inst.kind];
        if (i >= kinds[inst.kind].capacity) continue;
        quat.setFromAxisAngle(up, inst.yaw);
        vPos.set(inst.x - anchorX, inst.y, inst.z - anchorZ);
        vScale.set(inst.width, inst.height, inst.kind === 'rock' ? inst.width * 0.8 : inst.width);
        // Rock geometry stands 1.25 tall; scale y so the instance's height is its true extent.
        if (inst.kind === 'rock') vScale.y = inst.height / 1.25;
        mesh.setMatrixAt(i, matrix.compose(vPos, quat, vScale));
        if (inst.kind === 'rock') mesh.setColorAt(i, item(tints, inst.tint));
        counts[inst.kind] = i + 1;
      }
    }
    instanceTotal = 0;
    for (const kind of ['kelp', 'grass', 'rock'] as const) {
      const mesh = meshes[kind];
      mesh.count = counts[kind];
      mesh.instanceMatrix.needsUpdate = true;
      instanceTotal += counts[kind];
    }
    if (meshes.rock.instanceColor) meshes.rock.instanceColor.needsUpdate = true;
  }

  function rebuildSchools(): void {
    let n = 0;
    schoolTotal = 0;
    for (const school of schools.loaded.values()) {
      if (!school || schoolTotal >= tier.schools) continue;
      schoolTotal++;
      for (let f = 0; f < tier.fish; f++) {
        const r = (k: number) => hash(school.id, f, k) / 0x100000000;
        aSchool.setXYZW(n, school.x - anchorX, school.y, school.z - anchorZ, school.loop);
        aLoop.setXYZW(n, school.speed, school.phase, school.spread, 0);
        // Slots fill a squashed ball, denser toward the middle.
        const u = r(1) * 2 - 1;
        const a = r(2) * Math.PI * 2;
        const d = Math.cbrt(r(3));
        const ring = Math.sqrt(1 - u * u);
        aFish.setXYZW(n, ring * Math.cos(a) * d * 1.4, u * d * 0.6, ring * Math.sin(a) * d, r(4) * 100);
        n++;
      }
    }
    fishGeometryInst.instanceCount = n;
    aSchool.needsUpdate = true;
    aLoop.needsUpdate = true;
    aFish.needsUpdate = true;
  }

  return {
    group,
    update(time, camWorldX, camWorldZ, whaleRender, origin, draw) {
      streamer.update(camWorldX, camWorldZ);
      schools.update(camWorldX, camWorldZ);
      group.visible = draw;
      if (dirty || schoolsDirty) {
        anchorX = origin.x;
        anchorZ = origin.z;
        // Both share the anchor, so rebuild both whenever either changes.
        rebuildLife();
        rebuildSchools();
        dirty = false;
        schoolsDirty = false;
      }
      group.position.set(anchorX - origin.x, 0, anchorZ - origin.z);
      shared.uTime.value = time;
      shared.uWhale.value.copy(whaleRender);
    },
    stats: () => ({ cells: streamer.loaded.size, instances: instanceTotal, schools: schoolTotal }),
    dispose() {
      streamer.dispose();
      schools.dispose();
      for (const kind of ['kelp', 'grass', 'rock'] as const) {
        kinds[kind].geometry.dispose();
        kinds[kind].material.dispose();
        meshes[kind].dispose();
      }
      fishBase.dispose();
      fishGeometryInst.dispose();
      fishMaterial.dispose();
    },
  };
}
