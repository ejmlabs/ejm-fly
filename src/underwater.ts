import * as THREE from 'three';
import type { SkyHandle } from './sky.js';
import type { QualityTier } from './quality.js';
import { clamp, lerp } from './math.js';
import { hash } from './rng.js';
import { WATER_LEVEL, underwaterUniforms, waterSignal, type FloatingOrigin, type WaterSignal } from './seams.js';
import { WATER_IOR, blendFog, depthLight, seenLight, waterTint, type FogState } from './underwater-optics.js';
import { DRAW_AS_AUTHORED_GLSL, SCENE_FROM_DISPLAY_GLSL, displayExposure, radianceFor } from './tone.js';
import { createFloorPatch } from './underwater-floor.js';
import { createSeafloor, type DepthAt, type Seafloor } from './seafloor.js';
import { createUnderwaterLife } from './underwater-life.js';
import { createSwarms } from './underwater-swarm.js';
import type { FeedSite } from './feed-sites.js';
import { GLSL_WATER_COMMON } from './underwater-glsl.js';
import { item } from './item.js';

/**
 * The view from under the surface: absorption fog, the surface seen from below
 * with Snell's window, light shafts, drifting particles, a caustic-lit seafloor
 * and a waterline overlay that hides the near-plane split while crossing.
 *
 * Everything here lives in render space and follows the camera. Patterns are
 * keyed to render position plus the origin modulo PATTERN_PERIOD, so a floating
 * origin recenter (always a multiple of that period) leaves them in place and
 * nothing needs to be shifted; the seafloor rebuilds from world positions.
 */

/** Objects on this layer are drawn by the main camera only, never by the water's mirror. */
export const UNDERWATER_LAYER = 2;
/** Every procedural pattern repeats over this many metres; the origin always snaps to a multiple of it. */
export const PATTERN_PERIOD = 256;

export interface UnderwaterOptions {
  sky: SkyHandle;
  /** Ground height at world X/Z (negative under the sea). */
  heightAt: (x: number, z: number, lod?: number) => number;
  /** Bathymetric depth for the seafloor; it must match the one main's own seafloor uses. */
  depthAt?: DepthAt;
  origin: FloatingOrigin;
  tier: QualityTier;
  seed?: number;
  /** The output applies the tone curve to the whole frame, cleared pixels included (the finish), so the clear colour is scene light. */
  clearInScene: boolean;
}

export interface UnderwaterHandle {
  /** `whale` (world metres) keeps scenery out of the camera's line to it and makes swarms part around it. */
  update: (dt: number, time: number, camera: THREE.PerspectiveCamera, whale?: { x: number; y: number; z: number }) => WaterSignal;
  readonly signal: WaterSignal;
  /** Seafloor relief (world coords) that the floor, life and feed sites all stand on. */
  seafloor: Seafloor;
  /** Feed sites currently drawn as swarms, nearest first. */
  readonly sites: readonly FeedSite[];
  stats: () => { lifeCells: number; lifeInstances: number; schools: number; swarms: number };
  dispose: () => void;
}

// The seafloor patch reaches past the underwater visibility on every tier (about 175 m across), so a coast's
// underwater flanks carry on into the haze instead of stopping where the patch ends.
const TIER = {
  low: { rays: 9, snow: 140, floorCells: 64, floorStep: 2.8, caustics: 1, budget: 500 },
  medium: { rays: 13, snow: 260, floorCells: 80, floorStep: 2.2, caustics: 2, budget: 900 },
  high: { rays: 16, snow: 380, floorCells: 96, floorStep: 1.8, caustics: 2, budget: 1400 },
} as const;

export function createUnderwater(scene: THREE.Scene, renderer: THREE.WebGLRenderer, options: UnderwaterOptions): UnderwaterHandle {
  const { sky, origin } = options;
  const tier = TIER[options.tier];
  const seed = options.seed ?? 1;
  const signal: WaterSignal = { depth: 0, submersion: 0, underwater: false };
  const exposure = () => renderer.toneMappingExposure;

  // Above-water state to blend from and restore to.
  const fog = scene.fog instanceof THREE.FogExp2 ? scene.fog : null;
  const above: FogState = { color: fog ? fog.color.clone() : sky.horizonColor.clone(), density: fog?.density ?? 0.00034 };
  let writtenDensity = NaN;
  const writtenColor = new THREE.Color(-1, -1, -1);
  const clearBase = renderer.getClearColor(new THREE.Color());
  const clearAlpha = renderer.getClearAlpha();
  // The lights are set from the sky's own values every frame; dim from those, not from what was written last.
  const lights = [
    { light: sky.sun, base: sky.lightBase.sun },
    { light: sky.hemi, base: sky.lightBase.hemi },
    { light: sky.ambient, base: sky.lightBase.ambient },
  ];
  const lightTint = new THREE.Color().setHex(0x7fd0dc, THREE.SRGBColorSpace);
  /** The colour the light keeps at depth, normalised so its brightest channel is 1. */
  const depthTint = new THREE.Color();
  const tinted = new THREE.Color();
  /** Adapted brightness: eases toward seenLight over a few seconds, as eyes adjust. */
  let adapted = 1;
  /** Seconds for the eye to adapt most of the way. */
  const ADAPT_SECONDS = 4;
  /**
   * Share of the sky's reflection environment that still lights things in deep water: the surface passes the sky only
   * through Snell's window, and the water's own light comes from the lights, which this view tints by depth. Near the
   * surface the scattered light is close to the sky's, so the share falls with depth, as the lights' tint does.
   */
  const SKY_IN_DEEP_WATER = 0.3;

  // three applies scene fog after tone mapping, so `scene.fog.color` is a display colour (as the
  // sky sets it); these shaders fog before tone mapping and take the matching radiance instead.
  const tint: FogState = { color: new THREE.Color(), density: 0 };
  const below: FogState = { color: new THREE.Color(), density: 0 };
  const blended: FogState = { color: new THREE.Color(), density: 0 };
  const fogRadiance = new THREE.Color();
  const lastBlend = new THREE.Color(-1, -1, -1);
  const clearColor = new THREE.Color();
  let tintDepth = NaN;
  let tintLight = NaN;

  // Light that made it through the surface, refracted toward the vertical.
  const sunWater = new THREE.Vector3();
  function refractSun(): void {
    const s = sky.sunDirection;
    const horizontal = Math.hypot(s.x, s.z);
    const sinAir = clamp(horizontal / Math.max(1e-6, s.length()), 0, 1);
    const sinWater = sinAir / WATER_IOR;
    const cosWater = Math.sqrt(1 - sinWater * sinWater);
    const hx = horizontal > 1e-6 ? s.x / horizontal : 0;
    const hz = horizontal > 1e-6 ? s.z / horizontal : 0;
    // Direction the light travels: down and away from the sun.
    sunWater.set(-hx * sinWater, -cosWater, -hz * sinWater).normalize();
  }
  refractSun();

  const display = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  const zenithBlue = display(0x5f97c9);
  const sunGlowDisplay = display(0xfff4dc);
  const zenithDisplay = new THREE.Color();
  const skyHorizon = new THREE.Color();
  const skyZenith = new THREE.Color();
  const sunGlow = new THREE.Color();
  /** What the window overhead shows, from the sky as it is now. */
  function lookUp(): void {
    radianceFor(sky.hazeGradient[0] ?? sky.hazeColor, exposure(), skyHorizon);
    zenithDisplay.copy(sky.hazeGradient[sky.hazeGradient.length - 1] ?? sky.hazeColor).lerp(zenithBlue, 0.45);
    radianceFor(zenithDisplay, exposure(), skyZenith);
    radianceFor(sunGlowDisplay, exposure(), sunGlow).multiplyScalar(1.4 * clamp(sky.sunDirection.y * 4, 0, 1));
  }
  lookUp();

  /** Uniforms every underwater material reads; updated once per frame. */
  const shared = {
    uTime: { value: 0 },
    uPattern: { value: new THREE.Vector2() },
    uFogColor: { value: new THREE.Color() },
    uFogDensity: { value: 0.03 },
    uLight: { value: 1 },
    uSunWater: { value: sunWater },
    uSunDir: { value: sky.sunDirection },
  };

  const group = new THREE.Group();
  group.name = 'underwater';
  scene.add(group);
  const layered = <T extends THREE.Object3D>(object: T): T => {
    object.layers.set(UNDERWATER_LAYER);
    object.frustumCulled = false;
    group.add(object);
    return object;
  };

  /* -------------------------------------------------------------- surface from below */

  const surfaceMaterial = new THREE.ShaderMaterial({
    name: 'underwater-surface',
    uniforms: {
      ...shared,
      uSkyHorizon: { value: skyHorizon },
      uSkyZenith: { value: skyZenith },
      uSunGlow: { value: sunGlow },
      uReflect: { value: new THREE.Color() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4( position, 1.0 );
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      ${GLSL_WATER_COMMON}
      uniform vec3 uSkyHorizon;
      uniform vec3 uSkyZenith;
      uniform vec3 uSunGlow;
      uniform vec3 uReflect;
      varying vec3 vWorld;

      void main() {
        vec3 toFrag = vWorld - cameraPosition;
        float dist = length( toFrag );
        vec3 v = toFrag / max( dist, 1e-4 );
        // Ripples fade with distance so the far surface does not shimmer into noise.
        vec2 slope = rippleSlope( vWorld.xz + uPattern, uTime ) / ( 1.0 + dist * 0.04 );
        vec3 n = normalize( vec3( slope.x, -1.0, slope.y ) );
        vec3 r = refract( v, n, ${WATER_IOR.toFixed(3)} );
        float through = step( 1e-5, dot( r, r ) );
        // Transmission falls toward the window edge (grazing exit), where the bright ring of horizon sits.
        float edge = smoothstep( 0.0, 0.32, r.y ) * through;
        float elevation = clamp( r.y, 0.0, 1.0 );
        vec3 skyColor = mix( uSkyHorizon, uSkyZenith, pow( elevation, 0.55 ) );
        float sunDot = max( dot( r, uSunDir ), 0.0 );
        vec3 window = skyColor * ( 0.75 + 0.5 * edge ) + uSunGlow * ( pow( sunDot, 900.0 ) * 6.0 + pow( sunDot, 24.0 ) * 0.35 ) * through;
        // Outside the window the surface mirrors the dim water below, a little lighter where waves tilt.
        vec3 mirror = uReflect * ( 0.9 + 3.0 * length( slope ) );
        vec3 color = mix( mirror, window, edge );
        gl_FragColor = vec4( waterFog( color, dist ), 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.FrontSide,
  });
  // Plane normal faces down: drawn only from below, culled from above.
  const surfaceGeometry = new THREE.PlaneGeometry(8000, 8000, 1, 1).rotateX(Math.PI / 2);
  const surface = layered(new THREE.Mesh(surfaceGeometry, surfaceMaterial));
  surface.renderOrder = -1;

  /* -------------------------------------------------------------- light shafts */

  const RAY_CELL = 64;
  const RAY_LENGTH = 34;
  const rayBase = new THREE.PlaneGeometry(1, 1, 1, 6).translate(0, -0.5, 0);
  const rayGeometry = new THREE.InstancedBufferGeometry();
  rayGeometry.index = rayBase.index;
  rayGeometry.setAttribute('position', rayBase.getAttribute('position'));
  rayGeometry.instanceCount = tier.rays;
  const rayData = new Float32Array(tier.rays * 4);
  for (let i = 0; i < tier.rays; i++) {
    const r = (k: number) => hash(seed, 0x5241, i, k) / 0x100000000;
    rayData[i * 4] = r(1) * RAY_CELL;
    rayData[i * 4 + 1] = r(2) * RAY_CELL;
    rayData[i * 4 + 2] = 0.6 + r(3) * 1.8;
    rayData[i * 4 + 3] = r(4);
  }
  rayGeometry.setAttribute('aRay', new THREE.InstancedBufferAttribute(rayData, 4));
  // Authored additive in display terms: shafts only ever brighten.
  const rayColor = display(0xd8f1ea);
  const rayMaterial = new THREE.ShaderMaterial({
    name: 'underwater-rays',
    uniforms: { ...shared, uRayColor: { value: rayColor }, uIntensity: { value: 0 }, displayExposure },
    vertexShader: /* glsl */ `
      uniform vec3 uSunWater;
      uniform float uTime;
      attribute vec4 aRay;
      varying vec3 vWorld;
      varying vec2 vShaft;
      varying float vFade;
      const float CELL = ${RAY_CELL.toFixed(1)};
      const float LENGTH = ${RAY_LENGTH.toFixed(1)};
      void main() {
        vec3 axis = uSunWater;
        // Slow sway, then wrap the shaft's middle into a cell around the camera.
        vec2 base = aRay.xy + vec2( sin( uTime * 0.05 + aRay.w * 6.283 ), cos( uTime * 0.043 + aRay.w * 4.1 ) ) * 2.0;
        vec2 mid = base + axis.xz * LENGTH * 0.5;
        vec2 rel = mid - cameraPosition.xz;
        rel -= CELL * floor( rel / CELL + 0.5 );
        vec3 top = vec3( cameraPosition.x + rel.x, 0.0, cameraPosition.z + rel.y ) - vec3( axis.x, 0.0, axis.z ) * LENGTH * 0.5;
        float along = -position.y;
        vec3 centre = top + axis * LENGTH * 0.5;
        vec3 side = normalize( cross( axis, normalize( cameraPosition - centre ) ) );
        float width = aRay.z * ( 1.0 + along * 0.9 );
        vec3 p = top + axis * along * LENGTH + side * position.x * width;
        vWorld = p;
        vShaft = vec2( position.x * 2.0, along );
        float wrapEdge = max( abs( rel.x ), abs( rel.y ) ) / CELL;
        float flicker = 0.65 + 0.35 * sin( uTime * ( 0.21 + aRay.w * 0.17 ) + aRay.w * 40.0 );
        vFade = ( 1.0 - smoothstep( 0.3, 0.48, wrapEdge ) ) * flicker;
        gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uRayColor;
      uniform float uIntensity;
      uniform float uFogDensity;
      ${SCENE_FROM_DISPLAY_GLSL}
      varying vec3 vWorld;
      varying vec2 vShaft;
      varying float vFade;
      void main() {
        float across = 1.0 - smoothstep( 0.0, 1.0, abs( vShaft.x ) );
        float along = smoothstep( 0.0, 0.08, vShaft.y ) * ( 1.0 - smoothstep( 0.25, 1.0, vShaft.y ) );
        float dist = distance( vWorld, cameraPosition );
        float near = smoothstep( 2.0, 9.0, dist );
        float fogT = exp( -pow( uFogDensity * dist, 2.0 ) );
        float light = exp( -0.05 * max( 0.0, -vWorld.y ) );
        float a = across * across * along * near * fogT * light * vFade * uIntensity;
        gl_FragColor = vec4( uRayColor * a, 1.0 );
        ${DRAW_AS_AUTHORED_GLSL}
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const rays = layered(new THREE.Mesh(rayGeometry, rayMaterial));
  rays.renderOrder = 2;

  /* -------------------------------------------------------------- drifting particles */

  const SNOW_CELL = 32;
  const snowPositions = new Float32Array(tier.snow * 3);
  const snowSeeds = new Float32Array(tier.snow);
  for (let i = 0; i < tier.snow; i++) {
    const r = (k: number) => hash(seed, 0x534e, i, k) / 0x100000000;
    snowPositions[i * 3] = r(1) * SNOW_CELL;
    snowPositions[i * 3 + 1] = r(2) * SNOW_CELL;
    snowPositions[i * 3 + 2] = r(3) * SNOW_CELL;
    snowSeeds[i] = r(4);
  }
  const snowGeometry = new THREE.BufferGeometry();
  snowGeometry.setAttribute('position', new THREE.BufferAttribute(snowPositions, 3));
  snowGeometry.setAttribute('aSeed', new THREE.BufferAttribute(snowSeeds, 1));
  const snowColor = radianceFor(display(0xb9d9d6), exposure());
  const snowMaterial = new THREE.ShaderMaterial({
    name: 'underwater-particles',
    uniforms: { ...shared, uScale: { value: 400 }, uColor: { value: snowColor } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uScale;
      attribute float aSeed;
      varying float vAlpha;
      varying float vDist;
      const float CELL = ${SNOW_CELL.toFixed(1)};
      void main() {
        vec3 drift = vec3( sin( uTime * 0.11 + aSeed * 31.0 ) * 0.6, -uTime * 0.035 * ( 0.5 + aSeed ), cos( uTime * 0.09 + aSeed * 17.0 ) * 0.6 );
        vec3 rel = position + drift - cameraPosition;
        rel -= CELL * floor( rel / CELL + 0.5 );
        vec3 p = cameraPosition + rel;
        vec4 view = viewMatrix * vec4( p, 1.0 );
        vDist = -view.z;
        float size = ( 0.025 + 0.035 * aSeed ) * uScale / max( 0.5, vDist );
        // Below a pixel, shrink the alpha rather than the point, so dots never flicker.
        vAlpha = clamp( size, 0.0, 1.0 ) * ( 1.0 - smoothstep( 0.3, 0.48, length( rel ) / CELL ) ) * ( 1.0 - smoothstep( -0.6, -0.1, p.y ) );
        gl_PointSize = clamp( size, 1.0, 6.0 );
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uLight;
      varying float vAlpha;
      varying float vDist;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float dot = 1.0 - smoothstep( 0.15, 0.5, length( c ) );
        float fogT = exp( -pow( uFogDensity * vDist, 2.0 ) );
        gl_FragColor = vec4( uColor * ( 0.4 + 0.6 * uLight ), dot * vAlpha * fogT * 0.55 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const snow = layered(new THREE.Points(snowGeometry, snowMaterial));
  snow.renderOrder = 3;

  /* -------------------------------------------------------------- seafloor */

  const seafloor = createSeafloor(seed, { heightAt: options.heightAt }, options.depthAt);
  const floor = createFloorPatch({
    heightAt: seafloor.heightAt,
    cells: tier.floorCells,
    step: tier.floorStep,
    budget: tier.budget,
    caustics: tier.caustics,
    shared,
    sand: radianceFor(display(0xc9b48a), exposure()),
    sandDark: radianceFor(display(0x8f8466), exposure()),
    rock: radianceFor(display(0x5d6660), exposure()),
    caustic: radianceFor(display(0xfff6e2), exposure()),
  });
  layered(floor.mesh);

  /* -------------------------------------------------------------- life and feed sites */

  const life = createUnderwaterLife(seed, seafloor.heightAt, options.tier, UNDERWATER_LAYER);
  group.add(life.group);
  const swarms = createSwarms(seed, seafloor.heightAt, options.tier, UNDERWATER_LAYER, shared, (hex) => radianceFor(display(hex), exposure()));
  group.add(swarms.group);
  const whaleRender = new THREE.Vector3();
  let pointScale = 400;

  /* -------------------------------------------------------------- waterline overlay */

  const overlayMaterial = new THREE.ShaderMaterial({
    name: 'underwater-waterline',
    uniforms: {
      ...shared,
      uNearToWorld: { value: new THREE.Matrix4() },
      uWater: { value: new THREE.Color() },
      uAir: { value: new THREE.Color() },
      uWaterAlpha: { value: 0 },
      uAirAlpha: { value: 0 },
      displayExposure,
    },
    vertexShader: /* glsl */ `
      uniform mat4 uNearToWorld;
      varying vec3 vNear;
      void main() {
        vec4 w = uNearToWorld * vec4( position.xy, -1.0, 1.0 );
        vNear = w.xyz / w.w;
        gl_Position = vec4( position.xy, 0.0, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      ${GLSL_WATER_COMMON}
      uniform vec3 uWater;
      uniform vec3 uAir;
      uniform float uWaterAlpha;
      uniform float uAirAlpha;
      varying vec3 vNear;
      ${SCENE_FROM_DISPLAY_GLSL}
      void main() {
        // The waterline where the swell crosses the lens, a few centimetres high.
        vec2 p = vNear.xz + uPattern;
        float level = 0.018 * sin( dot( p, vec2( 2.9, 1.7 ) ) + uTime * 1.9 ) + 0.012 * sin( dot( p, vec2( -1.3, 3.7 ) ) + uTime * 2.6 );
        float h = vNear.y - level;
        float aa = max( fwidth( h ), 1e-4 );
        float under = 1.0 - smoothstep( -aa, aa, h );
        float meniscus = exp( -abs( h ) / ( aa * 2.5 + 0.004 ) );
        vec3 color = mix( mix( uAir, uWater, under ), uWater * 0.45, meniscus * 0.8 );
        float alpha = max( mix( uAirAlpha, uWaterAlpha, under ), meniscus * 0.75 );
        gl_FragColor = vec4( color, alpha );
        ${DRAW_AS_AUTHORED_GLSL}
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const overlay = layered(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), overlayMaterial));
  overlay.renderOrder = 1000;
  const nearCorner = new THREE.Vector3();
  const nearMatrix = item(overlayMaterial.uniforms, 'uNearToWorld').value as THREE.Matrix4;

  /** Height range the near plane spans; the overlay only runs while it straddles the water. */
  function nearSpan(): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      nearCorner.set(x, y, -1).applyMatrix4(nearMatrix);
      lo = Math.min(lo, nearCorner.y);
      hi = Math.max(hi, nearCorner.y);
    }
    return [lo, hi];
  }

  /* -------------------------------------------------------------- update */

  const restoreState = () => {
    if (fog) {
      fog.color.copy(above.color);
      fog.density = above.density;
      writtenDensity = fog.density;
      writtenColor.copy(fog.color);
    }
    sky.sky.visible = true;
    renderer.setClearColor(clearBase, clearAlpha);
    for (const l of lights) {
      l.light.intensity = l.base.intensity;
      l.light.color.copy(l.base.color);
    }
    underwaterUniforms.underwaterMix.value = 0;
    group.visible = false;
  };
  let resting = false;

  function update(dt: number, time: number, camera: THREE.PerspectiveCamera, whale?: { x: number; y: number; z: number }): WaterSignal {
    camera.layers.enable(UNDERWATER_LAYER);
    waterSignal(camera.position.y, signal);
    // sky.update rewrites the density each frame; anything else is our own write from last frame.
    if (fog && fog.density !== writtenDensity) above.density = fog.density;
    if (fog && !fog.color.equals(writtenColor)) above.color.copy(fog.color);

    const s = signal.submersion;
    const depth = signal.depth;
    const camWorldX = camera.position.x + origin.x;
    const camWorldZ = camera.position.z + origin.z;

    // Warm the seafloor cache whenever the camera is near the water, so the first dive has a floor.
    // Without a whale the corridor collapses onto the camera, which the near fade already covers.
    if (whale) whaleRender.set(whale.x - origin.x, whale.y, whale.z - origin.z);
    else whaleRender.copy(camera.position);
    const near = camera.position.y < 4;
    if (near) floor.prepare(camWorldX, camWorldZ, origin);
    // Life and swarms stream (and draw) only near or under the water; above that nothing runs.
    const drawLife = depth > 0;
    if (near || drawLife) {
      life.update(time, camWorldX, camWorldZ, whaleRender, origin, drawLife);
      swarms.update(time, camWorldX, camWorldZ, whaleRender, origin, pointScale, drawLife);
    }

    if (s <= 0 && depth < -0.6) {
      if (!resting) restoreState();
      resting = true;
      return signal;
    }
    resting = false;
    group.visible = true;

    const daylight = sky.daylight;
    lookUp();
    if (!(Math.abs(depth - tintDepth) < 0.05) || Math.abs(daylight - tintLight) > 0.002) {
      tintDepth = depth;
      tintLight = daylight;
      waterTint(Math.max(0, depth), daylight, tint);
      radianceFor(tint.color, exposure(), below.color);
      below.density = tint.density;
    }
    // Whatever the camera sees through the lens is on its own side of the surface: hold the
    // murk back while above and go fully under soon after crossing; the waterline overlay
    // carries the visual transition across the split itself.
    const murk = fogMix(depth, s);
    blendFog(above, tint, murk, blended);
    if (!blended.color.equals(lastBlend)) {
      lastBlend.copy(blended.color);
      radianceFor(blended.color, exposure(), fogRadiance);
    }
    if (fog) {
      fog.color.copy(blended.color);
      fog.density = blended.density;
      writtenDensity = fog.density;
      writtenColor.copy(fog.color);
    }

    // Light fails with depth, red first and blue last; the eye adapts over a few seconds and never quite loses the whale.
    adapted += (seenLight(depth) - adapted) * (1 - Math.exp(-Math.max(0, dt) / ADAPT_SECONDS));
    depthLight(depth, depthTint);
    depthTint.multiplyScalar(1 / Math.max(depthTint.r, depthTint.g, depthTint.b));
    const light = lerp(1, adapted * 0.9, s);
    const deepen = s * smoothstep01(depth / 40);
    scene.environmentIntensity = sky.environmentLevel * light * lerp(1, SKY_IN_DEEP_WATER, deepen);
    for (const l of lights) {
      l.light.intensity = l.base.intensity * light;
      l.light.color.copy(l.base.color).lerp(lightTint, s * 0.55).lerp(tinted.copy(l.base.color).multiply(depthTint), deepen);
    }

    // Exponential-fog equivalent of the FogExp2 visibility, for shaders that fade linearly.
    // Same blend as the scene fog, so the land (no three fog) fades exactly like everything else.
    underwaterUniforms.underwaterMix.value = murk;
    // The land (the only reader) skips tone mapping, so it takes the display colour, like the clear colour.
    underwaterUniforms.underwaterColor.value.copy(tint.color);
    underwaterUniforms.underwaterDensity.value = below.density * 1.73;

    const below0 = depth > 0;
    sky.sky.visible = !below0;
    // The clear shows where nothing is drawn, so it is the colour everything else fades to.
    if (below0) renderer.setClearColor(options.clearInScene ? radianceFor(tint.color, exposure(), clearColor) : clearColor.copy(tint.color), 1);
    else renderer.setClearColor(clearBase, clearAlpha);

    shared.uTime.value = time;
    shared.uPattern.value.set(mod(origin.x, PATTERN_PERIOD), mod(origin.z, PATTERN_PERIOD));
    shared.uFogColor.value.copy(fogRadiance);
    shared.uFogDensity.value = blended.density;
    shared.uLight.value = adapted * daylight;
    refractSun();

    surface.visible = below0;
    rays.visible = below0;
    snow.visible = below0;
    if (below0) {
      surface.position.set(camera.position.x, WATER_LEVEL, camera.position.z);
      const reflect = item(surfaceMaterial.uniforms, 'uReflect').value as THREE.Color;
      reflect.copy(below.color).multiplyScalar(0.8);
      item(rayMaterial.uniforms, 'uIntensity').value = 0.22 * smoothstep01(depth / 0.8) * daylight * (0.35 + 0.65 * clamp(sky.sunDirection.y * 2.5, 0, 1));
      pointScale = (renderer.getDrawingBufferSize(tmpSize).y * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
      item(snowMaterial.uniforms, 'uScale').value = pointScale;
    }
    floor.update(camWorldX, camWorldZ, origin, below0);

    // Waterline across the lens while the near plane straddles the surface.
    camera.updateMatrixWorld();
    nearMatrix.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    const [lo, hi] = nearSpan();
    overlay.visible = lo < WATER_LEVEL + 0.08 && hi > WATER_LEVEL - 0.08;
    if (overlay.visible) {
      const u = overlayMaterial.uniforms;
      (item(u, 'uWater').value as THREE.Color).copy(tint.color);
      (item(u, 'uAir').value as THREE.Color).copy(sky.hazeColor);
      item(u, 'uWaterAlpha').value = below0 ? 0 : 0.82;
      item(u, 'uAirAlpha').value = below0 ? 0.55 : 0;
    }
    return signal;
  }

  const tmpSize = new THREE.Vector2();
  group.visible = false;

  return {
    update,
    signal,
    seafloor,
    get sites() {
      return swarms.sites;
    },
    stats() {
      const l = life.stats();
      return { lifeCells: l.cells, lifeInstances: l.instances, schools: l.schools, swarms: swarms.sites.length };
    },
    dispose() {
      restoreState();
      scene.remove(group);
      surfaceGeometry.dispose();
      surfaceMaterial.dispose();
      rayBase.dispose();
      rayGeometry.dispose();
      rayMaterial.dispose();
      snowGeometry.dispose();
      snowMaterial.dispose();
      floor.dispose();
      life.dispose();
      swarms.dispose();
      overlay.geometry.dispose();
      overlayMaterial.dispose();
    },
  };
}

/** Fog weight for the view: a light approach haze above the surface, full water just below it. */
export function fogMix(depth: number, submersion: number): number {
  return depth > 0 ? lerp(0.9, 1, smoothstep01(depth / 0.25)) : submersion * 0.5;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function smoothstep01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}
