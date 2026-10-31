import * as THREE from 'three';
import type { QualityTier } from './quality.js';
import type { FloatingOrigin } from './seams.js';
import { hash } from './rng.js';
import { feedSitesNear, type FeedSite } from './feed-sites.js';
import { item } from './item.js';

/**
 * Krill clouds and bait balls drawn at the feed sites near the camera. Each
 * swarm is a point cloud whose swirl runs in the vertex shader; particles near
 * the whale are pushed aside, so the swarm parts as it passes and closes again
 * behind it.
 */

/** How many sites are drawn at once (nearest first). */
export const SWARM_SLOTS = 3;
/** Sites further than this from the camera are not drawn (well past the fog). */
export const SWARM_RANGE = 140;
/** The site query re-runs after the camera moves this far. */
const REQUERY = 30;

const COUNTS: Record<QualityTier, { krill: number; baitball: number }> = {
  low: { krill: 420, baitball: 240 },
  medium: { krill: 700, baitball: 380 },
  high: { krill: 1000, baitball: 520 },
};

export interface Swarms {
  group: THREE.Group;
  /** Sites currently drawn, nearest first. */
  readonly sites: readonly FeedSite[];
  update: (time: number, camWorldX: number, camWorldZ: number, whaleRender: THREE.Vector3, origin: FloatingOrigin, pointScale: number, draw: boolean) => void;
  dispose: () => void;
}

function swarmGeometry(count: number, salt: number): THREE.BufferGeometry {
  const position = new Float32Array(count * 3);
  const orbit = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = (k: number) => hash(salt, i, k) / 0x100000000;
    // Unit offset inside the ball (denser toward the middle) and an orbit tilt, speed and phase.
    const u = r(1) * 2 - 1;
    const a = r(2) * Math.PI * 2;
    const d = Math.pow(r(3), 0.6);
    const ring = Math.sqrt(1 - u * u);
    position.set([ring * Math.cos(a) * d, u * d * 0.7, ring * Math.sin(a) * d], i * 3);
    orbit.set([(r(4) - 0.5) * 0.8, 0.6 + 0.8 * r(5), r(6) * 100, r(7)], i * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
  return g;
}

export function createSwarms(seed: number, floorAt: (x: number, z: number) => number, tier: QualityTier, layer: number, fogUniforms: { uFogColor: THREE.IUniform; uFogDensity: THREE.IUniform; uLight: THREE.IUniform },
  /** Scene radiance for an sRGB display colour, so colours read as chosen after tone mapping. */
  radiance: (hex: number) => THREE.Color,
): Swarms {
  const group = new THREE.Group();
  group.name = 'underwater-swarms';
  group.visible = false;
  const counts = COUNTS[tier];
  const geometries = { krill: swarmGeometry(counts.krill, 0x4b52), baitball: swarmGeometry(counts.baitball, 0x4242) };

  const slots = Array.from({ length: SWARM_SLOTS }, () => {
    const material = new THREE.ShaderMaterial({
      name: 'underwater-swarm',
      uniforms: {
        ...fogUniforms,
        uTime: { value: 0 },
        uCentre: { value: new THREE.Vector3() },
        uRadius: { value: 5 },
        uWhale: { value: new THREE.Vector3() },
        uScale: { value: 400 },
        uColor: { value: new THREE.Color() },
        uSpin: { value: 0.3 },
        uSize: { value: 0.05 },
        uGlint: { value: 0 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCentre;
        uniform float uRadius;
        uniform vec3 uWhale;
        uniform float uScale;
        uniform float uSpin;
        uniform float uSize;
        uniform float uGlint;
        attribute vec4 aOrbit;
        varying float vAlpha;
        varying float vDist;
        varying float vShine;
        void main() {
          // Each particle circles the vertical axis at its own rate, with a tilt that makes the ball churn.
          float a = uTime * uSpin * aOrbit.y + aOrbit.z;
          float c = cos( a );
          float s = sin( a );
          vec3 p = vec3( position.x * c - position.z * s, position.y, position.x * s + position.z * c );
          p.y += aOrbit.x * ( p.x * c ) * 0.6 + 0.12 * sin( uTime * 0.8 + aOrbit.z );
          // The cloud breathes slowly.
          p *= uRadius * ( 1.0 + 0.08 * sin( uTime * 0.4 + aOrbit.w * 6.0 ) );
          vec3 world = uCentre + p;
          // Part around the whale: push particles out of a bubble around it, smoothly.
          vec3 away = world - uWhale;
          float gap = length( away );
          float bubble = uRadius * 0.6 + 6.0;
          world += away / max( gap, 1e-3 ) * ( bubble - gap ) * ( 1.0 - smoothstep( 0.0, bubble, gap ) ) * 1.2;
          vec4 view = viewMatrix * vec4( world, 1.0 );
          vDist = -view.z;
          float size = uSize * uScale / max( 0.5, vDist );
          vAlpha = clamp( size, 0.0, 1.0 ) * ( 1.0 - smoothstep( -1.0, -0.2, world.y ) );
          vShine = 1.0 + uGlint * pow( max( 0.0, sin( uTime * 3.0 * aOrbit.y + aOrbit.z * 7.0 ) ), 12.0 );
          gl_PointSize = clamp( size, 1.0, 7.0 );
          gl_Position = projectionMatrix * view;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uLight;
        varying float vAlpha;
        varying float vDist;
        varying float vShine;
        void main() {
          float d = length( gl_PointCoord - 0.5 );
          float dotMask = 1.0 - smoothstep( 0.2, 0.5, d );
          float fogT = exp( -pow( uFogDensity * vDist, 2.0 ) );
          vec3 color = mix( uFogColor, uColor * vShine * ( 0.45 + 0.55 * uLight ), fogT );
          gl_FragColor = vec4( color, dotMask * vAlpha * ( 0.35 + 0.55 * fogT ) );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(geometries.krill, material);
    points.frustumCulled = false;
    points.layers.set(layer);
    points.visible = false;
    group.add(points);
    return { points, material };
  });

  const looks = {
    krill: { color: radiance(0xd9927a), spin: 0.12, size: 0.045, glint: 0 },
    baitball: { color: radiance(0xc9dbe2), spin: 0.45, size: 0.07, glint: 1.6 },
  };

  let sites: FeedSite[] = [];
  let lastX = NaN;
  let lastZ = NaN;

  return {
    group,
    get sites() {
      return sites;
    },
    update(time, camWorldX, camWorldZ, whaleRender, origin, pointScale, draw) {
      if (!(Math.hypot(camWorldX - lastX, camWorldZ - lastZ) < REQUERY)) {
        lastX = camWorldX;
        lastZ = camWorldZ;
        sites = feedSitesNear(seed, camWorldX, camWorldZ, SWARM_RANGE, floorAt)
          .filter((site) => Math.hypot(site.x - camWorldX, site.z - camWorldZ) < SWARM_RANGE)
          .slice(0, SWARM_SLOTS);
      }
      group.visible = draw;
      if (!draw) return;
      slots.forEach((slot, i) => {
        const site = sites[i];
        slot.points.visible = !!site;
        if (!site) return;
        const look = looks[site.kind];
        const u = slot.material.uniforms;
        slot.points.geometry = geometries[site.kind];
        (item(u, 'uCentre').value as THREE.Vector3).set(site.x - origin.x, site.y, site.z - origin.z);
        item(u, 'uRadius').value = site.radius;
        item(u, 'uTime').value = time;
        (item(u, 'uWhale').value as THREE.Vector3).copy(whaleRender);
        item(u, 'uScale').value = pointScale;
        (item(u, 'uColor').value as THREE.Color).copy(look.color);
        item(u, 'uSpin').value = look.spin;
        item(u, 'uSize').value = look.size;
        item(u, 'uGlint').value = look.glint;
      });
    },
    dispose() {
      geometries.krill.dispose();
      geometries.baitball.dispose();
      for (const slot of slots) slot.material.dispose();
    },
  };
}
