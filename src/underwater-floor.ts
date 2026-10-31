import * as THREE from 'three';
import type { FloatingOrigin } from './seams.js';
import { GLSL_WATER_COMMON } from './underwater-glsl.js';

/**
 * A square seafloor patch that follows the camera. Heights come from the land
 * field on a world-anchored grid and are cached in a toroidal buffer, so moving
 * only samples the new rows; a per-frame budget spreads the first fill out.
 */

/** The patch recentres in steps of this many cells. */
const SNAP = 4;
/** Sunk a little so it never fights the land mesh along the shallows. */
const SINK = 0.15;

export interface FloorPatchOptions {
  /** Seafloor height at world X/Z (seafloor.ts keeps it within sight of a diving whale). */
  heightAt: (x: number, z: number) => number;
  cells: number;
  step: number;
  budget: number;
  caustics: number;
  shared: Record<string, THREE.IUniform>;
  sand: THREE.Color;
  sandDark: THREE.Color;
  rock: THREE.Color;
  caustic: THREE.Color;
}

export interface FloorPatch {
  mesh: THREE.Mesh;
  /** Fill the height cache around a world position without drawing. */
  prepare: (worldX: number, worldZ: number, origin: FloatingOrigin) => void;
  update: (worldX: number, worldZ: number, origin: FloatingOrigin, visible: boolean) => void;
  dispose: () => void;
}

/** Height drawn for the seafloor at a sampled ground height (land is flattened; the land mesh covers it). */
export function visualFloor(height: number): number {
  return Math.min(2, height) - SINK;
}

/** Grid cell the patch centres on for a world position. */
export function floorCentre(world: number, step: number): number {
  return Math.round(world / step / SNAP) * SNAP;
}

export function createFloorPatch(options: FloorPatchOptions): FloorPatch {
  const { cells: N, step } = options;
  const M = N + 1;
  const half = N / 2;
  const heights = new Float32Array(M * M);
  const tagX = new Int32Array(M * M).fill(-0x7fffffff);
  const tagZ = new Int32Array(M * M).fill(-0x7fffffff);

  const positions = new Float32Array(M * M * 3);
  const normals = new Float32Array(M * M * 3);
  const index: number[] = [];
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const a = z * M + x;
      index.push(a, a + M, a + 1, a + 1, a + M, a + M + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  const normalAttr = new THREE.BufferAttribute(normals, 3);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('normal', normalAttr);
  geometry.setIndex(index);

  const material = new THREE.ShaderMaterial({
    name: 'underwater-floor',
    uniforms: {
      ...options.shared,
      uSand: { value: options.sand },
      uSandDark: { value: options.sandDark },
      uRock: { value: options.rock },
      uCaustic: { value: options.caustic },
    },
    defines: { CAUSTIC_LAYERS: options.caustics },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        vec4 world = modelMatrix * vec4( position, 1.0 );
        vWorld = world.xyz;
        vNormal = normal;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      ${GLSL_WATER_COMMON}
      uniform vec3 uSand;
      uniform vec3 uSandDark;
      uniform vec3 uRock;
      uniform vec3 uCaustic;
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        vec2 p = vWorld.xz + uPattern;
        vec3 n = normalize( vNormal );
        float grain = tiledNoise( p / 8.0, 32.0 ) * 0.6 + tiledNoise( p / 2.0, 128.0 ) * 0.4;
        vec3 albedo = mix( uSandDark, uSand, grain );
        albedo = mix( albedo, uRock, smoothstep( 0.93, 0.72, n.y ) );
        // Deep basins silt over: duller and greyer than the sunny shelf.
        albedo = mix( albedo, uRock * 0.9, smoothstep( 22.0, 40.0, -vWorld.y ) * 0.45 );
        float depth = max( 0.0, -vWorld.y );
        // Light reaching the floor: weaker and bluer the deeper it is.
        float sunLit = max( dot( n, -uSunWater ), 0.0 );
        float reach = exp( -0.055 * depth );
        float c = causticLayer( p / 2.0, 128.0, uTime * 0.9 );
        #if CAUSTIC_LAYERS > 1
          c = c * 0.65 + causticLayer( p / 3.2 + 7.0, 80.0, uTime * 0.7 ) * 0.5;
        #endif
        // Patchy: the swell focuses light strongly in some places and barely in others.
        c *= ( 0.3 + 0.7 * tiledNoise( p / 16.0 + uTime * 0.02, 16.0 ) ) * exp( -0.03 * depth ) * sunLit;
        vec3 lit = albedo * ( 0.32 + 0.68 * sunLit ) + uCaustic * c * 0.16;
        vec3 absorb = mix( vec3( 1.0 ), vec3( 0.62, 0.86, 0.88 ), 1.0 - exp( -depth / 10.0 ) );
        vec3 color = lit * absorb * reach * ( 0.45 + 0.55 * uLight );
        gl_FragColor = vec4( waterFog( color, distance( vWorld, cameraPosition ) ), 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'seafloor';
  mesh.visible = false;

  let built = false;
  let builtX = 0;
  let builtZ = 0;
  let wantX = NaN;
  let wantZ = NaN;
  let scan = 0;

  function slot(gx: number, gz: number): number {
    return (((gz % M) + M) % M) * M + (((gx % M) + M) % M);
  }

  /** Samples missing cells for the window around (cx, cz); true once all are present. */
  function fill(cx: number, cz: number): boolean {
    if (cx !== wantX || cz !== wantZ) {
      wantX = cx;
      wantZ = cz;
      scan = 0;
    }
    let spent = 0;
    for (let k = scan; k < M * M; k++) {
      const gx = cx - half + (k % M);
      const gz = cz - half + Math.floor(k / M);
      const s = slot(gx, gz);
      if (tagX[s] === gx && tagZ[s] === gz) continue;
      if (spent >= options.budget) {
        scan = k;
        return false;
      }
      heights[s] = visualFloor(options.heightAt(gx * step, gz * step));
      tagX[s] = gx;
      tagZ[s] = gz;
      spent++;
    }
    scan = M * M;
    return true;
  }

  function heightCell(gx: number, gz: number, cx: number, cz: number): number {
    const x = Math.min(cx + half, Math.max(cx - half, gx));
    const z = Math.min(cz + half, Math.max(cz - half, gz));
    return heights[slot(x, z)] ?? 0;
  }

  function build(cx: number, cz: number): void {
    for (let iz = 0; iz < M; iz++) {
      for (let ix = 0; ix < M; ix++) {
        const gx = cx - half + ix;
        const gz = cz - half + iz;
        const v = (iz * M + ix) * 3;
        positions[v] = (ix - half) * step;
        positions[v + 1] = heights[slot(gx, gz)] ?? 0;
        positions[v + 2] = (iz - half) * step;
        const dx = heightCell(gx + 1, gz, cx, cz) - heightCell(gx - 1, gz, cx, cz);
        const dz = heightCell(gx, gz + 1, cx, cz) - heightCell(gx, gz - 1, cx, cz);
        const inv = 1 / Math.hypot(dx, 2 * step, dz);
        normals[v] = -dx * inv;
        normals[v + 1] = 2 * step * inv;
        normals[v + 2] = -dz * inv;
      }
    }
    positionAttr.needsUpdate = true;
    normalAttr.needsUpdate = true;
    geometry.computeBoundingSphere();
    built = true;
    builtX = cx;
    builtZ = cz;
  }

  function sync(worldX: number, worldZ: number): void {
    const cx = floorCentre(worldX, step);
    const cz = floorCentre(worldZ, step);
    if (built && cx === builtX && cz === builtZ) return;
    if (fill(cx, cz)) build(cx, cz);
  }

  return {
    mesh,
    prepare(worldX, worldZ) {
      sync(worldX, worldZ);
    },
    update(worldX, worldZ, origin, visible) {
      if (visible) sync(worldX, worldZ);
      mesh.visible = visible && built;
      // Placed from world cells each frame, so a recenter needs no bookkeeping.
      mesh.position.set(builtX * step - origin.x, 0, builtZ * step - origin.z);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
