import * as THREE from 'three';
import { fork } from './rng.js';
import { SEA_GLSL } from './ocean.js';
import { SEA_WAVES } from './swell.js';
import type { QualityTier } from './quality.js';
import { DRAW_AS_AUTHORED_GLSL, SCENE_FROM_DISPLAY_GLSL, displayExposure } from './tone.js';

/** Rain streaks and spray per tier: the most that can show, at full rain and the roughest sea. */
export const FX_COUNTS: Record<QualityTier, { rain: number; spray: number }> = {
  low: { rain: 1500, spray: 250 },
  medium: { rain: 4000, spray: 600 },
  high: { rain: 7000, spray: 1000 },
};

/** Size of the box of rain around the camera (m); it wraps, so the rain stays put in the world as the camera moves. */
export const RAIN_BOX = new THREE.Vector3(70, 36, 70);
const SPRAY_BOX = 90;
/** Metres per second: drops fall at 9, and the wind carries them up to 7 sideways. */
const FALL = 9;
const DRIFT = 7;
/** Spray puffs never grow past this many pixels across, however close to the camera. */
const SPRAY_MAX_PX = 64;

/** The rain's velocity (m/s) in a wind of 0 to 1 blowing toward `windAngle`. */
export function rainVelocity(wind: number, windAngle: number): [number, number, number] {
  return [Math.cos(windAngle) * DRIFT * wind, -FALL - 3 * wind, Math.sin(windAngle) * DRIFT * wind];
}

/**
 * Moves the rain's drift `offset` on by `velocity` over `dt` seconds, in place, wrapped into the rain box. Integrated
 * here rather than as velocity times time in the shader, so a change of wind changes how the rain moves, never where it is.
 */
export function stepRain(offset: number[], velocity: readonly number[], dt: number): number[] {
  const box = [RAIN_BOX.x, RAIN_BOX.y, RAIN_BOX.z];
  for (let i = 0; i < 3; i++) {
    const at = ((offset[i] ?? 0) + (velocity[i] ?? 0) * dt) % (box[i] ?? 0);
    offset[i] = at < 0 ? at + (box[i] ?? 0) : at;
  }
  return offset;
}

export interface WeatherFxInput {
  /** Render coordinates. */
  camera: THREE.PerspectiveCamera;
  /** Seconds; frozen under reduced motion. */
  time: number;
  rain: number;
  wind: number;
  sea: number;
  windAngle: number;
  /** Brightness of the light, 0 (night) to 1. */
  light: number;
  /** Drawing buffer height in pixels, for spray sizes. */
  height: number;
}

export interface WeatherFx {
  /** Added to the scene (render coordinates). */
  group: THREE.Group;
  update: (input: WeatherFxInput) => void;
  setTier: (tier: QualityTier) => void;
  /** Draws made last frame. */
  draws: () => number;
  dispose: () => void;
}

/**
 * Rain and wind-blown spray, each one draw computed on the GPU from a per-particle seed: rain as streaks that
 * fall and drift with the wind (its drift integrated here) in a box round the camera, spray as soft puffs torn off the crests of a rough sea.
 * `waves` is the water's packed swell (shared, so the spray rides the same crests).
 */
export function createWeatherFx(seed: number, tier: QualityTier, waves: Float32Array): WeatherFx {
  const rng = fork(seed, 4101);
  const most = FX_COUNTS.high;

  // Rain: two vertices a drop, head and tail, each with the drop's seed (x, y, z in the box, w for which drops show).
  const rainSeeds = new Float32Array(most.rain * 2 * 4);
  const rainTail = new Float32Array(most.rain * 2);
  for (let i = 0; i < most.rain; i++) {
    const seedOf = [rng(), rng(), rng(), rng()];
    rainSeeds.set(seedOf, i * 8);
    rainSeeds.set(seedOf, i * 8 + 4);
    rainTail[i * 2 + 1] = 1;
  }
  const rainGeometry = new THREE.BufferGeometry();
  // Positions are computed in the shader; this attribute only carries the seed (three needs a `position`).
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(most.rain * 2 * 3), 3));
  rainGeometry.setAttribute('drop', new THREE.BufferAttribute(rainSeeds, 4));
  rainGeometry.setAttribute('tail', new THREE.BufferAttribute(rainTail, 1));
  const rainUniforms = {
    uOffset: { value: new THREE.Vector3() },
    uCentre: { value: new THREE.Vector3() },
    uBox: { value: RAIN_BOX.clone() },
    uVelocity: { value: new THREE.Vector3(0, -FALL, 0) },
    uAmount: { value: 0 },
    uLight: { value: 1 },
    displayExposure,
  };
  const rainMaterial = new THREE.ShaderMaterial({
    name: 'rain',
    uniforms: rainUniforms,
    vertexShader: /* glsl */ `
      attribute vec4 drop;
      attribute float tail;
      uniform vec3 uOffset;
      uniform vec3 uCentre;
      uniform vec3 uBox;
      uniform vec3 uVelocity;
      uniform float uAmount;
      varying float vAlpha;
      void main() {
        // Fixed in the world, wrapped into the box round the camera.
        vec3 p = mod( drop.xyz * uBox + uOffset - uCentre, uBox ) - uBox * 0.5;
        // A streak: the tail is where the drop was a fortieth of a second ago, longer in a gale.
        vec3 world = uCentre + p - uVelocity * tail * 0.045;
        float fade = 1.0 - smoothstep( 0.25, 0.5, length( p.xz ) / uBox.x );
        vAlpha = step( drop.w, uAmount ) * fade * ( 1.0 - tail * 0.85 ) * step( 0.0, world.y );
        gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform float uLight;
      varying float vAlpha;
      ${SCENE_FROM_DISPLAY_GLSL}
      void main() {
        gl_FragColor = vec4( vec3( 0.62, 0.68, 0.74 ) * ( 0.15 + 0.85 * uLight ), vAlpha * 0.55 );
        // Authored as sRGB values written straight to the screen.
        gl_FragColor = sRGBTransferEOTF( gl_FragColor );
        ${DRAW_AS_AUTHORED_GLSL}
      }`,
    transparent: true,
    depthWrite: false,
  });
  const rain = new THREE.LineSegments(rainGeometry, rainMaterial);
  rain.frustumCulled = false;
  rain.renderOrder = 3;

  // Spray: one point a puff, its seed (x, z in the box, a phase and a size).
  const spraySeeds = new Float32Array(most.spray * 4);
  for (let i = 0; i < spraySeeds.length; i++) spraySeeds[i] = rng();
  const sprayGeometry = new THREE.BufferGeometry();
  sprayGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(most.spray * 3), 3));
  sprayGeometry.setAttribute('puff', new THREE.BufferAttribute(spraySeeds, 4));
  const sprayUniforms = {
    uTime: { value: 0 },
    uCentre: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector2(1, 0) },
    uSea: { value: 0 },
    uLight: { value: 1 },
    displayExposure,
    uScale: { value: 400 },
    seaWaves: { value: waves },
  };
  const sprayMaterial = new THREE.ShaderMaterial({
    name: 'spray',
    uniforms: sprayUniforms,
    vertexShader: /* glsl */ `
      attribute vec4 puff;
      uniform float uTime;
      uniform vec3 uCentre;
      uniform vec2 uWind;
      uniform float uSea;
      uniform float uScale;
      varying float vAlpha;
      ${SEA_GLSL}
      void main() {
        // Each puff lives 2.5 s, torn off a crest and carried downwind as it rises and falls back.
        float life = fract( uTime / 2.5 + puff.z );
        float cycle = floor( uTime / 2.5 + puff.z );
        vec2 cell = vec2( fract( puff.x + cycle * 0.618 ), fract( puff.y + cycle * 0.382 ) ) * ${SPRAY_BOX.toFixed(1)};
        vec2 base = uCentre.xz + mod( cell - uCentre.xz, ${SPRAY_BOX.toFixed(1)} ) - ${(SPRAY_BOX / 2).toFixed(1)};
        float top = 0.0;
        for ( int i = 0; i < ${String(SEA_WAVES)}; i++ ) top += seaWaves[ i ].z;
        float h = seaHeight( base, 0.0, 1e6 );
        float crest = smoothstep( 0.45, 0.8, h / max( top, 0.05 ) ) * smoothstep( 0.4, 0.85, uSea );
        vec3 world = vec3( base + uWind * life * 5.0, h + 0.2 + sin( life * 3.1416 ) * ( 0.6 + 1.4 * uSea ) );
        vAlpha = crest * sin( life * 3.1416 );
        vec4 view = viewMatrix * vec4( world, 1.0 );
        gl_PointSize = vAlpha > 0.0 ? min( ( 0.5 + puff.w ) * 1.6 * uScale / max( 1.0, -view.z ), ${SPRAY_MAX_PX.toFixed(1)} ) : 0.0;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uLight;
      varying float vAlpha;
      ${SCENE_FROM_DISPLAY_GLSL}
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float disc = max( 0.0, 1.0 - dot( c, c ) );
        gl_FragColor = vec4( vec3( 0.86, 0.9, 0.92 ) * ( 0.12 + 0.88 * uLight ), disc * disc * vAlpha * 0.5 );
        // Authored as sRGB values written straight to the screen.
        gl_FragColor = sRGBTransferEOTF( gl_FragColor );
        ${DRAW_AS_AUTHORED_GLSL}
      }`,
    transparent: true,
    depthWrite: false,
  });
  const spray = new THREE.Points(sprayGeometry, sprayMaterial);
  spray.frustumCulled = false;
  spray.renderOrder = 3;

  const group = new THREE.Group();
  group.name = 'weather';
  group.add(rain, spray);
  // Layer 1: the page's camera draws them, the water's mirror does not.
  for (const object of [rain, spray]) object.layers.set(1);

  const setTier = (next: QualityTier) => {
    rainGeometry.setDrawRange(0, FX_COUNTS[next].rain * 2);
    sprayGeometry.setDrawRange(0, FX_COUNTS[next].spray);
  };
  setTier(tier);

  let drawn = 0;
  const rainOffset = [0, 0, 0];
  let lastTime: number | null = null;
  return {
    group,
    update(input) {
      const { camera } = input;
      const above = camera.position.y > 0;
      rain.visible = above && input.rain > 0.01;
      spray.visible = above && input.sea > 0.4;
      const dx = Math.cos(input.windAngle);
      const dz = Math.sin(input.windAngle);
      const dt = lastTime === null ? 0 : Math.max(0, input.time - lastTime);
      lastTime = input.time;
      if (rain.visible) {
        const velocity = rainVelocity(input.wind, input.windAngle);
        stepRain(rainOffset, velocity, dt);
        rainUniforms.uOffset.value.fromArray(rainOffset);
        rainUniforms.uCentre.value.copy(camera.position);
        rainUniforms.uVelocity.value.fromArray(velocity);
        rainUniforms.uAmount.value = input.rain;
        rainUniforms.uLight.value = input.light;
      }
      if (spray.visible) {
        sprayUniforms.uTime.value = input.time;
        sprayUniforms.uCentre.value.copy(camera.position);
        sprayUniforms.uWind.value.set(dx * (0.4 + input.wind), dz * (0.4 + input.wind));
        sprayUniforms.uSea.value = input.sea;
        sprayUniforms.uLight.value = input.light;
        sprayUniforms.uScale.value = input.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      }
      drawn = (rain.visible ? 1 : 0) + (spray.visible ? 1 : 0);
    },
    setTier,
    draws: () => drawn,
    dispose() {
      rainGeometry.dispose();
      rainMaterial.dispose();
      sprayGeometry.dispose();
      sprayMaterial.dispose();
    },
  };
}
