import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { fork } from './rng.js';
import { clamp, lerp, smoothstep } from './math.js';
import { patchShader, type ShaderPatch } from './shader-patch.js';
import type { WeatherLook } from './weather.js';
import { item } from './item.js';
import { drawAsAuthored } from './tone.js';

export type TimeOfDay = 'golden' | 'morning' | 'afternoon' | 'dusk';
/** The day runs through these in order; night comes after dusk and gives way to morning. */
export type DayPhase = TimeOfDay | 'night';

/** Light that survives the weather and the time of day: what the lights are set to, before the underwater view dims them. */
export interface LightBase { intensity: number; color: THREE.Color }

export interface SkyHandle {
  sky: Sky;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
  /** What the three lights were set to this frame (the underwater view dims from these, not from the lights it may have dimmed). */
  lightBase: { sun: LightBase; hemi: LightBase; ambient: LightBase };
  /** Updated in place every frame. */
  sunDirection: THREE.Vector3;
  sunAzimuthDeg: number;
  horizonColor: THREE.Color;
  /** Display colour of the sky just above the horizon; distant land hazes toward it. Updated in place. */
  hazeColor: THREE.Color;
  /** Sky colours at HAZE_ANGLES; a peak hazes toward the sky right behind it. Updated in place. */
  hazeGradient: THREE.Color[];
  /** Land haze density now. */
  hazeDensity: number;
  /** The preset the day began in. */
  timeOfDay: TimeOfDay;
  /** The preset the day is in now, and how far it is through the day (0 to 1). */
  phase: () => { name: DayPhase; day: number };
  /** How bright the day is now, 0 (night) to 1 (noon): dims what the sun does not light itself. */
  daylight: number;
  /** How much light the shallows get now (a low sun lights them less). */
  shallowLight: number;
  /** Land and water brightness now, 0 to 1. */
  level: number;
  /** How strongly the stars show now, 0 (day, thick cloud) to 1. */
  stars: number;
  /** Strength of the reflection environment above water now, as `scene.environmentIntensity` (the underwater view dims it). */
  environmentLevel: number;
  /** The seed's own cloud cover under a clear sky. */
  clearCover: number;
  /** Direction the wind blows toward (radians, as the clouds drift): waves and rain follow it. */
  windAngle: number;
  /** Sunset or sunrise glow now, 0 to 1: a low sun under a sky clear enough to colour. */
  glow: number;
  /** Milliseconds the last environment refresh took on the CPU side, and how many ran. */
  environment: () => { ms: number; count: number };
  envMap: THREE.Texture | null;
  /** The fog of the place the sea is in: pulled toward `tint` by `mix`, its density scaled. */
  setFog: (tint: THREE.Color, mix: number, density: number) => void;
  /** The weather's look; eased by the caller. */
  setWeather: (look: WeatherLook) => void;
  /** Moves the day and the clouds on by `dt` seconds. `rate` is 1 normally, 0.5 for reduced motion: half the cloud drift and a slower day. */
  update: (dt: number, rate?: number) => void;
  /** Where in the day, in whole days with the preset the day began in at 0 (review shots and tests). */
  setDay: (day: number) => void;
  /** Rebuilds the reflection environment from the sky now; at most every ENV_REFRESH seconds on its own once enabled. */
  refreshEnvironment: () => void;
  /** Turns the timed refresh on (medium and high) or off (low); turned off, the environment is rebuilt once to be kept. */
  setEnvironmentRefresh: (on: boolean) => void;
  dispose: () => void;
}

interface Preset {
  elevation: number;
  azimuth: number;
  turbidity: number;
  rayleigh: number;
  mie: number;
  exposure: number;
  mieG: number;
  /** Sky colour at HAZE_ANGLES, sRGB. */
  haze: number[];
  hazeDensity: number;
  /** Fog colour at the horizon, before the water's pull. */
  horizon: [number, number, number];
  sun: { color: number; intensity: number };
  hemi: { sky: number; ground: number; intensity: number };
  ambient: { color: number; intensity: number };
  /** Brightness of the day for what the sun does not light, and of the shallows. */
  daylight: number;
  shallow: number;
  /** Brightness of the land and water. */
  level: number;
}

/** The sun's light at a clear noon. */
export const SUN_INTENSITY = 2;
const SUN = { color: 0xfff1d6, intensity: SUN_INTENSITY };
const HEMI = { sky: 0xc0d4e8, ground: 0x2a3e4e, intensity: 0.75 };
const AMBIENT = { color: 0x6a8498, intensity: 0.4 };

/** What each time of day sets; `tools/haze-measure.ts` checks each `haze` against the sky the rest of it makes. */
export const presets: Record<DayPhase, Preset> = {
  // Low turbidity and mie keep the sky horizon from blooming into a cream band; little rayleigh and a wide mie lobe
  // keep the air clear (the sun's glow adds to both). Away from the sun, where the camera looks, `cloudPatches` warms it.
  golden: {
    elevation: 7, azimuth: 185, turbidity: 3, rayleigh: 0.55, mie: 0.003, exposure: 0.54, mieG: 0.5,
    haze: [0xb1675a, 0xa47461, 0x7e7871, 0x4c667b, 0x2b5075], hazeDensity: 0.00044,
    horizon: [0.8, 0.42, 0.3], sun: SUN, hemi: HEMI, ambient: AMBIENT, daylight: 0.62, shallow: 0.55, level: 1,
  },
  morning: {
    elevation: 22, azimuth: 140, turbidity: 2.6, rayleigh: 1.4, mie: 0.003, exposure: 0.48, mieG: 0.78,
    haze: [0xd4d9da, 0xccd9da, 0xb7d2da, 0x92bfd6, 0x6fa6ce], hazeDensity: 0.00028,
    horizon: [0.4, 0.5, 0.58], sun: SUN, hemi: HEMI, ambient: AMBIENT, daylight: 0.92, shallow: 1, level: 1,
  },
  afternoon: {
    elevation: 38, azimuth: 200, turbidity: 2.0, rayleigh: 1.4, mie: 0.0028, exposure: 0.46, mieG: 0.78,
    haze: [0xeaeeee, 0xe5edee, 0xd7e8ee, 0xbbdaea, 0x9cc8e5], hazeDensity: 0.00026,
    horizon: [0.38, 0.48, 0.58], sun: SUN, hemi: HEMI, ambient: AMBIENT, daylight: 1, shallow: 1, level: 1,
  },
  dusk: {
    elevation: 4, azimuth: 250, turbidity: 3, rayleigh: 0.6, mie: 0.003, exposure: 0.45, mieG: 0.5,
    haze: [0x6e2721, 0x6e3525, 0x544132, 0x313c41, 0x1a2f43], hazeDensity: 0.0005,
    horizon: [0.5, 0.15, 0.05], sun: SUN, hemi: HEMI, ambient: AMBIENT, daylight: 0.5, shallow: 0.55, level: 1,
  },
  // The sun well below the horizon: the sky keeps a faint blue glow, the moon is only a cool fill light.
  night: {
    elevation: -13, azimuth: 300, turbidity: 3, rayleigh: 1.2, mie: 0.003, exposure: 0.55, mieG: 0.78,
    haze: [0x0b1220, 0x0b1424, 0x0b1626, 0x0a1628, 0x09142a], hazeDensity: 0.00036,
    horizon: [0.045, 0.065, 0.1], sun: { color: 0x9db4e0, intensity: 0 }, hemi: { sky: 0x3a5078, ground: 0x0c1620, intensity: 0.42 },
    ambient: { color: 0x2c4262, intensity: 0.3 }, daylight: 0.12, shallow: 0.2, level: 0.16,
  },
};

/** The order of a day. */
export const DAY: readonly DayPhase[] = ['morning', 'afternoon', 'golden', 'dusk', 'night'];
/** Seconds of the experience for one full day. */
export const DAY_SECONDS = 2400;

/** Elevation angles (degrees above the horizon) of the measured sky colours. */
export const HAZE_ANGLES = [0.3, 2, 5, 10, 16];

/** Stars: fade in as the sun sets below this elevation (degrees), full below the second. */
export const STARS_FROM = 3;
export const STARS_FULL = -8;
const STAR_COUNT = 900;
/** Sunset and sunrise glow with the sun between these elevations (degrees), strongest just above the horizon. */
export const GLOW_FROM = 18;
export const GLOW_UNDER = -10;
/** A lightning flash lifts the sky's own light by at most this share. */
export const FLASH_LIFT = 0.35;

export const FOG_DENSITY = 0.00034;
/** Seconds between environment map refreshes. */
export const ENV_REFRESH = 90;

export function pickTimeOfDay(seed: number): TimeOfDay {
  const rng = fork(seed, 'tod');
  const names: TimeOfDay[] = ['golden', 'morning', 'afternoon', 'dusk'];
  return item(names, Math.floor(rng() * names.length));
}

function sunVector(elevationDeg: number, azimuthDeg: number, target: THREE.Vector3): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  target.setFromSphericalCoords(1, phi, theta);
  return target;
}

/** Fog colour at the horizon for a preset: sky-matched, pulled toward the water so no bright band shows at the seam. */
function horizonFor(preset: Preset, elevation: number): THREE.Color {
  const color = new THREE.Color().setRGB(preset.horizon[0], preset.horizon[1], preset.horizon[2]);
  if (preset.level >= 1) color.lerp(new THREE.Color(0.42, 0.56, 0.68), clamp(elevation / 55, 0, 0.45));
  return color.lerp(new THREE.Color(0x163e54), preset.level >= 1 ? 0.42 : 0.2);
}

/**
 * The model scatters light once, so away from a low sun its horizon goes from brown through olive to blue, a murky
 * green-teal with nothing of the sunset in it. A low sun in fact reddens the air along the whole horizon, so the
 * glow multiplies the sky by a warm tint that thins upward within a few degrees: orange at the horizon, lilac-grey
 * above it, then the model's own blue. The tint is per channel and falls off with the sine of the elevation, both
 * ways: below the horizon the sky is hidden by the sea on screen but stands in for it in the reflection environment,
 * where a full tint lit every face that looks down or across (a breaching whale's belly) red.
 */
const BELT_TINT = [2.8, 0.9, 0.75] as const;
const BELT_FALLOFF = 6.4;
const glsl = (value: number) => value.toFixed(2);

/** Moves the sky's clouds along a wind vector instead of a fixed diagonal, lets weather grey and darken the sky, and warms its horizon at sunset. */
export const cloudPatches: ShaderPatch[] = [
  { find: 'uniform float time;', replace: 'uniform float time;\n\t\tuniform vec2 cloudWind;\n\t\tuniform float skyDim;\n\t\tuniform float skyGrey;\n\t\tuniform float skyGlow;' },
  {
    find: 'vec3 texColor = ( Lin + L0 ) * 0.04 + sundiscColor + vec3( 0.0, 0.0003, 0.00075 );',
    // The sun disc stays out of the belt: it already sits near the top of what a half float holds.
    replace: `vec3 texColor = ( Lin + L0 ) * 0.04 + vec3( 0.0, 0.0003, 0.00075 );
\t\t\ttexColor *= 1.0 + skyGlow * exp( -abs( direction.y ) * ${glsl(BELT_FALLOFF)} ) * ( vec3( ${BELT_TINT.map(glsl).join(', ')} ) - 1.0 );
\t\t\ttexColor += sundiscColor;`,
  },
  { find: 'cloudUV += time * cloudSpeed;', replace: 'cloudUV += time * cloudSpeed * cloudWind;' },
  // Storm cloud is dark underneath.
  { find: 'cloudColor *= max( dayFactor, 0.03 );', replace: 'cloudColor *= max( dayFactor, 0.03 ) * skyDim;' },
  {
    find: 'gl_FragColor = vec4( texColor, 1.0 );',
    replace: 'gl_FragColor = vec4( mix( texColor, vec3( dot( texColor, vec3( 0.2126, 0.7152, 0.0722 ) ) ), skyGrey ) * skyDim, 1.0 );',
  },
];

/** Cloud speed of the three.js sky (its own default is 0.00002 along a fixed diagonal). */
const CLOUD_SPEED = 0.00008;

/** Warms a colour toward a sunset: more red, a little less blue. */
function warm(color: THREE.Color, amount: number): THREE.Color {
  color.r *= 1 + 0.55 * amount;
  color.g *= 1 + 0.06 * amount;
  color.b *= 1 - 0.38 * amount;
  return color;
}

/** A grey of the same brightness as the colour: fog and haze pulled toward it lose their tint, not their light. */
function greyen(color: THREE.Color, amount: number): THREE.Color {
  if (amount <= 0) return color;
  const luma = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
  color.r += (luma - color.r) * amount;
  color.g += (luma - color.g) * amount;
  color.b += (luma - color.b) * amount;
  return color;
}

interface Blend {
  elevation: number;
  azimuth: number;
  turbidity: number;
  rayleigh: number;
  mie: number;
  mieG: number;
  exposure: number;
  hazeDensity: number;
  daylight: number;
  shallow: number;
  level: number;
  sun: number;
  hemi: number;
  ambient: number;
}

export function createSky(
  seed: number,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  /** Whether the reflection environment follows the day (medium and high) or is built once and kept (low). */
  environmentFollows = false,
): SkyHandle {
  const timeOfDay = pickTimeOfDay(seed);
  const start = DAY.indexOf(timeOfDay);
  const rng = fork(seed, 'sky-jitter');
  const jitterElevation = (rng() - 0.5) * 4;
  const jitterAzimuth = (rng() - 0.5) * 24;
  const baseCover = 0.12 + rng() * 0.1;
  // Cloud drift: a wind direction of the seed's own.
  const windAngle = rng() * Math.PI * 2;

  const sky = new Sky();
  sky.scale.setScalar(12000);
  const patched = patchShader(sky.material.fragmentShader, cloudPatches);
  if (patched !== null) {
    sky.material.fragmentShader = patched;
    sky.material.uniforms['cloudWind'] = { value: new THREE.Vector2(Math.cos(windAngle), Math.sin(windAngle)) };
    sky.material.uniforms['skyDim'] = { value: 1 };
    sky.material.uniforms['skyGrey'] = { value: 0 };
    sky.material.uniforms['skyGlow'] = { value: 0 };
    sky.material.needsUpdate = true;
  }
  const uniforms = sky.material.uniforms;
  // The sun's position as a typed uniform this module keeps, in place of the sky's own.
  const sunPosition = { value: new THREE.Vector3() };
  uniforms['sunPosition'] = sunPosition;
  if (uniforms['cloudCoverage']) uniforms['cloudCoverage'].value = baseCover;
  if (uniforms['cloudDensity']) uniforms['cloudDensity'].value = 0.15;
  if (uniforms['cloudSpeed']) uniforms['cloudSpeed'].value = patched !== null ? CLOUD_SPEED : 0.00002;
  if (uniforms['showSunDisc']) uniforms['showSunDisc'].value = 1;

  // Stars: one points object on the dome, a child of the sky so it hides with it under water.
  const starRng = fork(seed, 4001);
  const starPositions = new Float32Array(STAR_COUNT * 3);
  const starColors = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Uniform over the upper hemisphere, kept off the horizon haze.
    const y = 0.04 + starRng() * 0.96;
    const a = starRng() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    starPositions.set([Math.cos(a) * r * 0.9, y * 0.9, Math.sin(a) * r * 0.9], i * 3);
    // Mostly faint, a few bright, a little blue or warm.
    const bright = 0.25 + 0.75 * starRng() ** 3;
    const warm = starRng() - 0.5;
    starColors.set([bright * (1 + 0.25 * warm), bright, bright * (1 - 0.25 * warm)], i * 3);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  starGeometry.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
  // Round, soft stars from a small generated disc.
  const disc = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const u = (x - 3.5) / 4;
      const v = (y - 3.5) / 4;
      disc.fill(Math.round(255 * Math.max(0, 1 - u * u - v * v) ** 0.8), (y * 8 + x) * 4, (y * 8 + x) * 4 + 4);
    }
  }
  const starMap = new THREE.DataTexture(disc, 8, 8, THREE.RGBAFormat);
  starMap.magFilter = THREE.LinearFilter;
  starMap.minFilter = THREE.LinearFilter;
  starMap.needsUpdate = true;
  const starMaterial = drawAsAuthored(new THREE.PointsMaterial({
    size: 1.7 * renderer.getPixelRatio(),
    alphaMap: starMap,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  }));
  const starPoints = new THREE.Points(starGeometry, starMaterial);
  starPoints.visible = false;
  starPoints.renderOrder = 1;
  starPoints.frustumCulled = false;
  // Layer 1 is seen by the page's camera but not by the water's mirror, whose small picture would smear the stars.
  starPoints.layers.set(1);
  sky.add(starPoints);

  const sunDirection = new THREE.Vector3();
  const sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
  sun.castShadow = false;
  const hemi = new THREE.HemisphereLight(HEMI.sky, HEMI.ground, HEMI.intensity);
  const ambient = new THREE.AmbientLight(AMBIENT.color, AMBIENT.intensity);
  scene.add(sky);
  scene.add(sun);
  scene.add(hemi);
  scene.add(ambient);

  /** A preset's sun elevation with the seed's jitter; the night's stays well below the horizon. */
  const elevationOf = (name: DayPhase): number =>
    name === 'night' ? presets.night.elevation : clamp(presets[name].elevation + jitterElevation, 2, 45);

  // Per preset colours, built once.
  const colors = DAY.map((name) => {
    const preset = presets[name];
    const elevation = elevationOf(name);
    return {
      horizon: horizonFor(preset, elevation),
      haze: preset.haze.map((hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)),
      sun: new THREE.Color(preset.sun.color),
      hemiSky: new THREE.Color(preset.hemi.sky),
      hemiGround: new THREE.Color(preset.hemi.ground),
      ambient: new THREE.Color(preset.ambient.color),
    };
  });

  const horizonColor = new THREE.Color();
  const hazeGradient = HAZE_ANGLES.map(() => new THREE.Color());
  const hazeColor = item(hazeGradient, 0);
  const lightBase = {
    sun: { intensity: SUN.intensity, color: new THREE.Color(SUN.color) },
    hemi: { intensity: HEMI.intensity, color: new THREE.Color(HEMI.sky) },
    ambient: { intensity: AMBIENT.intensity, color: new THREE.Color(AMBIENT.color) },
  };

  scene.fog = new THREE.FogExp2(0x000000, FOG_DENSITY);
  scene.background = null;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  let time = 0;
  /** Position in the day: whole numbers are presets, counted from morning; the seed starts at its own. */
  let cycle = start;
  const regionFog = { tint: new THREE.Color(), mix: 0, density: 1 };
  const weather: WeatherLook = { coverage: baseCover, density: 0.15, fog: 1, haze: 1, sun: 1, grey: 0, rain: 0, wind: 0, dark: 0, sea: 0, flash: 0 };
  const blend: Blend = {
    elevation: 0, azimuth: 0, turbidity: 0, rayleigh: 0, mie: 0, mieG: 0, exposure: 0, hazeDensity: 0,
    daylight: 1, shallow: 1, level: 1, sun: 0, hemi: 0, ambient: 0,
  };

  /** Sets everything that follows the time of day and the weather. */
  function applyDay(): void {
    const count = DAY.length;
    const wrapped = ((cycle % count) + count) % count;
    const index = Math.floor(wrapped);
    const next = (index + 1) % count;
    const t = smoothstep(0, 1, wrapped - index);
    const a = presets[item(DAY, index)];
    const b = presets[item(DAY, next)];
    const ca = item(colors, index);
    const cb = item(colors, next);
    blend.elevation = lerp(elevationOf(item(DAY, index)), elevationOf(item(DAY, next)), t);
    // The sun keeps moving the same way round: past the last preset the morning's azimuth is a turn further on.
    blend.azimuth = lerp(a.azimuth, b.azimuth + (next === 0 ? 360 : 0), t) + jitterAzimuth;
    blend.turbidity = lerp(a.turbidity, b.turbidity, t);
    blend.rayleigh = lerp(a.rayleigh, b.rayleigh, t);
    blend.mie = lerp(a.mie, b.mie, t);
    blend.mieG = lerp(a.mieG, b.mieG, t);
    blend.exposure = lerp(a.exposure, b.exposure, t);
    blend.hazeDensity = lerp(a.hazeDensity, b.hazeDensity, t);
    blend.daylight = lerp(a.daylight, b.daylight, t);
    blend.shallow = lerp(a.shallow, b.shallow, t);
    blend.level = lerp(a.level, b.level, t);
    blend.sun = lerp(a.sun.intensity, b.sun.intensity, t);
    blend.hemi = lerp(a.hemi.intensity, b.hemi.intensity, t);
    blend.ambient = lerp(a.ambient.intensity, b.ambient.intensity, t);

    const wobble = Math.sin(time * 0.02) * 0.4;
    const elevation = blend.elevation + wobble;
    // A low sun colours the sky when the cloud lets it: vivid under a broken sky, grey under overcast.
    const glow = (1 - smoothstep(2, GLOW_FROM, elevation)) * smoothstep(GLOW_UNDER, 0, elevation) * (1 - smoothstep(0.1, 0.6, weather.grey));
    handle.glow = glow;
    item(uniforms, 'turbidity').value = blend.turbidity + 2 * glow;
    item(uniforms, 'rayleigh').value = blend.rayleigh + 1 * glow;
    item(uniforms, 'mieCoefficient').value = blend.mie + 0.001 * glow;
    if (uniforms['skyDim']) uniforms['skyDim'].value = (1 - 0.9 * weather.dark) * (1 + FLASH_LIFT * weather.flash);
    if (uniforms['skyGrey']) uniforms['skyGrey'].value = 0.85 * weather.grey;
    if (uniforms['skyGlow']) uniforms['skyGlow'].value = glow;
    item(uniforms, 'mieDirectionalG').value = blend.mieG;
    if (uniforms['cloudCoverage']) uniforms['cloudCoverage'].value = weather.coverage;
    if (uniforms['cloudDensity']) uniforms['cloudDensity'].value = weather.density;
    sunVector(elevation, blend.azimuth, sunDirection);
    sunPosition.value.copy(sunDirection);
    sun.position.copy(sunDirection).multiplyScalar(200);
    // A storm darkens the whole view; lightning lifts it a little, softly.
    renderer.toneMappingExposure = blend.exposure * 0.88 * (1 - 0.45 * weather.dark) * (1 + 0.12 * weather.flash);

    // A veiled sun gives less light; the sky gives a little more of its own.
    const veil = 1 - weather.sun;
    const lightBaseSun = lightBase.sun;
    lightBaseSun.intensity = blend.sun * weather.sun;
    warm(lightBaseSun.color.copy(ca.sun).lerp(cb.sun, t), glow * 0.8);
    const lift = (1 - 0.45 * weather.dark) * (1 + FLASH_LIFT * weather.flash);
    lightBase.hemi.intensity = blend.hemi * (1 + 0.25 * veil) * lift;
    lightBase.hemi.color.copy(ca.hemiSky).lerp(cb.hemiSky, t);
    lightBase.ambient.intensity = blend.ambient * (1 + 0.35 * veil) * lift;
    lightBase.ambient.color.copy(ca.ambient).lerp(cb.ambient, t);
    sun.intensity = lightBase.sun.intensity;
    sun.color.copy(lightBase.sun.color);
    hemi.intensity = lightBase.hemi.intensity;
    hemi.color.copy(lightBase.hemi.color);
    hemi.groundColor.copy(ca.hemiGround).lerp(cb.hemiGround, t);
    ambient.intensity = lightBase.ambient.intensity;
    ambient.color.copy(lightBase.ambient.color);

    // Haze: the sky's own colours (the sunset's warmth is in the measured ones), greyer under cloud, darker in a storm.
    const shade = 1 - 0.5 * weather.dark;
    for (let k = 0; k < hazeGradient.length; k++) {
      greyen(item(hazeGradient, k).copy(item(ca.haze, k)).lerp(item(cb.haze, k), t), weather.grey).multiplyScalar(shade);
    }
    horizonColor.copy(ca.horizon).lerp(cb.horizon, t);
    warm(greyen(horizonColor, weather.grey).multiplyScalar(shade), glow * 0.45);

    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.density = lerp(FOG_DENSITY * 0.92, FOG_DENSITY * 1.08, 0.5 + 0.5 * Math.sin(time * 0.015)) * regionFog.density * weather.fog;
      // A region's tint is a daytime colour: it fades with the light.
      fog.color.copy(horizonColor).lerp(regionFog.tint, regionFog.mix * blend.level);
    }
    // Stars come out as the sun drops below the dusk and go as it rises; thick cloud hides them.
    const dark = 1 - smoothstep(STARS_FULL, STARS_FROM, elevation);
    const cloud = clamp((weather.coverage - 0.25) / 0.55, 0, 1);
    handle.stars = dark * (1 - 0.95 * cloud);
    starMaterial.opacity = handle.stars;
    starPoints.visible = handle.stars > 0.01;
    // They wheel slowly with the day.
    starPoints.rotation.y = cycle * 0.15;
    handle.hazeDensity = blend.hazeDensity;
    handle.daylight = blend.daylight;
    handle.shallowLight = blend.shallow;
    // Land and water darken under a storm, as the sky does.
    handle.level = blend.level * (1 - 0.6 * weather.dark) * (1 + FLASH_LIFT * weather.flash);
  }

  // Environment: rebuilt from the sky alone; a full scene would reflect the water and land in themselves.
  let pmrem: THREE.PMREMGenerator | null = null;
  let envTarget: THREE.WebGLRenderTarget | null = null;
  let envEnabled = environmentFollows;
  /** The sky's light when the environment was built: a kept one dims as the day darkens below it. */
  let envLevel = 1;
  let envAge = 0;
  const hidden: THREE.Object3D[] = [];

  let envMs = 0;
  let envCount = 0;
  function refreshEnvironment(): void {
    envAge = 0;
    const began = performance.now();
    try {
      pmrem ??= new THREE.PMREMGenerator(renderer);
      for (const child of scene.children) {
        if (child !== sky && child.visible) {
          hidden.push(child);
          child.visible = false;
        }
      }
      const skyWasVisible = sky.visible;
      sky.visible = true;
      if (uniforms['showSunDisc']) uniforms['showSunDisc'].value = 0;
      // An environment that is kept lights every time of day after it, so it leaves out the sunset's few minutes.
      const glow = uniforms['skyGlow'] as THREE.IUniform<number> | undefined;
      const glowNow = glow?.value ?? 0;
      if (glow && !envEnabled) glow.value = 0;
      const next = pmrem.fromScene(scene, 0.04);
      if (glow) glow.value = glowNow;
      envLevel = handle.level;
      if (uniforms['showSunDisc']) uniforms['showSunDisc'].value = 1;
      sky.visible = skyWasVisible;
      const previous = envTarget;
      envTarget = next;
      handle.envMap = next.texture;
      scene.environment = next.texture;
      previous?.dispose();
    } catch {
      // No environment: the lights alone.
    } finally {
      for (const child of hidden) child.visible = true;
      hidden.length = 0;
      envMs = performance.now() - began;
      envCount++;
    }
  }

  /** A followed environment carries the sky's own light; a kept one is dimmed to it, never brightened past how it was built. */
  function lightEnvironment(): void {
    handle.environmentLevel = envEnabled ? 1 : Math.min(1, handle.level / Math.max(1e-3, envLevel));
    scene.environmentIntensity = handle.environmentLevel;
  }

  const handle: SkyHandle = {
    sky,
    sun,
    hemi,
    ambient,
    lightBase,
    sunDirection,
    sunAzimuthDeg: presets[timeOfDay].azimuth + jitterAzimuth,
    horizonColor,
    hazeColor,
    hazeGradient,
    hazeDensity: presets[timeOfDay].hazeDensity,
    timeOfDay,
    daylight: presets[timeOfDay].daylight,
    shallowLight: presets[timeOfDay].shallow,
    level: 1,
    stars: 0,
    environmentLevel: 1,
    clearCover: baseCover,
    windAngle,
    glow: 0,
    environment: () => ({ ms: envMs, count: envCount }),
    envMap: null,
    phase() {
      const count = DAY.length;
      const wrapped = ((cycle % count) + count) % count;
      return { name: item(DAY, Math.round(wrapped) % count), day: wrapped / count };
    },
    setFog(tint, mix, density) {
      regionFog.tint.copy(tint);
      regionFog.mix = mix;
      regionFog.density = density;
    },
    setWeather(look) {
      Object.assign(weather, look);
    },
    update(dt, rate = 1) {
      time += dt * rate;
      envAge += dt;
      if (uniforms['time']) uniforms['time'].value = time;
      cycle += (dt * rate * DAY.length) / DAY_SECONDS;
      applyDay();
      if (envEnabled && envAge >= ENV_REFRESH) refreshEnvironment();
      lightEnvironment();
    },
    setDay(day) {
      cycle = start + day * DAY.length;
      applyDay();
      lightEnvironment();
    },
    refreshEnvironment,
    setEnvironmentRefresh(on) {
      if (on === envEnabled) return;
      envEnabled = on;
      if (!on) refreshEnvironment();
      lightEnvironment();
    },
    dispose() {
      scene.remove(sky, sun, hemi, ambient);
      starGeometry.dispose();
      starMaterial.dispose();
      starMap.dispose();
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      envTarget?.dispose();
      pmrem?.dispose();
      if (scene.environment === handle.envMap) scene.environment = null;
    },
  };

  applyDay();
  // The first environment is the opening sky, as before; later ones follow the day.
  refreshEnvironment();
  return handle;
}
