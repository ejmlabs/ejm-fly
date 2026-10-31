import * as THREE from 'three';
import { resolveSeed, seedURL, nextSeed } from './seed.js';
import { createQuality, detailFor, updateQuality } from './quality.js';
import { layoutWorld } from './terrain.js';
import { createSky, HAZE_ANGLES, SUN_INTENSITY } from './sky.js';
import { createWhale, skinMs, type WhalePhase } from './whale.js';
import { PHASE_LEN } from './whale-motion.js';
import { createWorld } from './world.js';
import { createBirds } from './birds.js';
import { FOV, FollowCamera } from './camera.js';
import { clamp, smoothstep } from './math.js';
import { DEPTH_SCALE, LENGTH_SCALE } from './whale-size.js';
import { createUI } from './ui.js';
import { OceanAudio } from './audio.js';
import { loadMemory, saveMemory, VERSION } from './persistence.js';
import { createUnderwater, UNDERWATER_LAYER } from './underwater.js';
import { createFishShowcase } from './fish-mesh.js';
import { feedSitesNear } from './feed-sites.js';
import { createSeafloor } from './seafloor.js';
import { createRegionLook } from './region-look.js';
import { REGION_LOOKS } from './regions.js';
import { setSea, swellAt, swellRate } from './swell.js';
import { TRAVEL_MAX } from './whale-behavior.js';
import { createWeather, type WeatherState } from './weather.js';
import { createRoute } from './route.js';
import { createWake } from './wake.js';
import { createShipFx } from './ship-fx.js';
import { createMoverSync, createObstacles } from './obstacles.js';
import { createWeatherFx } from './weather-fx.js';
import { createLandLife, HERD_CELL, TOWN_CELL } from './land-life.js';
import { PACES, type Pace } from './pace.js';
import { createViewControls } from './view-controls.js';
import { createFinish, frameMode, isFrameMode } from './finish.js';
import { displayExposure } from './tone.js';
import { item } from './item.js';

interface CalmReview {
  time: number;
  advance: (seconds: number) => void;
  /** Swims the whale on for this many seconds of simulation (30 Hz steps), streaming the world as it goes. */
  travel: (seconds: number) => void;
  /** Optional normalised start time; 0 starts below the surface so the exit splash is visible. */
  forceBreach: (at?: number) => void;
  forceSpout: () => void;
  /** Optional yaw offset from broadside, pitch and distance for close-up review. */
  frameWhale: (kind?: 'breach' | 'spout', yawOffset?: number, pitch?: number, distance?: number) => void;
  /** Review view relative to the whale's heading (yaw 0 = behind); `follow()` returns to the chase. */
  frame: (yaw: number, pitch: number, distance: number) => void;
  follow: () => void;
  setWaterVisible: (visible: boolean) => void;
  setWhaleVisible: (visible: boolean) => void;
  setLandVisible: (visible: boolean) => void;
  setShipsVisible: (visible: boolean) => void;
  /** Start the long deep dive now (whale holds position while forced). */
  forceDeepDive: (at?: number) => void;
  /** Play any phase of the whale from normalised time `at` (whale holds position while forced). */
  forceWhale: (phase: WhalePhase, at?: number) => void;
  /** Debug camera `depth` metres under the surface (negative is above), looking at the whale; null releases it. */
  peekUnderwater: (depth: number | null, site?: boolean) => void;
  /** Where in the day (0 is the preset the seed began in, 1 a full day on), and the weather to hold. */
  setDay: (day: number) => void;
  setWeather: (state: WeatherState) => void;
  /** Hold the sea at a level, 0 glassy to 1 rough, or null to let the weather drive it. */
  setSea: (level: number | null) => void;
  setRoute: (on: boolean) => void;
  /** Puts the whale in open water near world (x, z) and loads the sea around it. */
  jumpTo: (x: number, z: number) => void;
  /**
   * Towns and herds within `radius` of the whale, nearest first: where, ground height, how many, and a vantage on
   * open water with a clear sightline to them (null when there is none within 400 m).
   */
  life: (radius: number) => { kind: 'town' | 'herd'; x: number; y: number; z: number; count: number; vantage: [number, number, number] | null }[];
  /** The highest land between `near` and `far` metres from the whale (world coordinates). */
  peak: (near: number, far: number) => { x: number; y: number; z: number };
  /** Review camera at world `from` looking at `to`, the whale and the land streamed around it; null returns to the chase. */
  view: (from: [number, number, number] | null, to?: [number, number, number]) => void;
  stats: () => Record<string, number | string | boolean | number[]>;
}

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';

/** Metres swum since the page opened (the route indicator's distance); in debug also the straight line from the start and how often the whale is back near an earlier spot (`path`, `net`, `revisit`). */
const journey = { path: 0, x: NaN, z: NaN, fromX: NaN, fromZ: NaN, fixes: [] as number[], fixAt: -Infinity, back: 0 };
/** A fix within this distance of one at least this many fixes (seconds) earlier counts as a revisit. */
const REVISIT_RADIUS = 500;
const REVISIT_AFTER = 120;
function markJourney(): void {
  const { x, z } = whale.state;
  if (Number.isNaN(journey.x)) Object.assign(journey, { x, z, fromX: x, fromZ: z });
  journey.path += Math.hypot(x - journey.x, z - journey.z);
  journey.x = x;
  journey.z = z;
  if (!debug || time - journey.fixAt < 1) return;
  journey.fixAt = time;
  const fixes = journey.fixes;
  for (let i = 0; i + 2 * REVISIT_AFTER < fixes.length; i += 2) {
    if (Math.hypot(x - (fixes[i] ?? 0), z - (fixes[i + 1] ?? 0)) < REVISIT_RADIUS) {
      journey.back++;
      break;
    }
  }
  fixes.push(x, z);
}

/** Metres to the nearest land sampled on rings around (x, z) out to `reach`, or `reach` when there is none. */
function landWithin(x: number, z: number, reach: number): number {
  for (let d = 250; d <= reach; d += 250) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      if (world.land.maskAt(x + Math.cos(a) * d, z + Math.sin(a) * d) > 0) return d;
    }
  }
  return reach;
}

let storage: Storage | null;
try {
  storage = window.localStorage;
} catch {
  storage = null;
}

const memory = loadMemory(storage);
let routeOn = memory?.route ?? false;
let followDives = memory?.dives ?? true;
let pace: Pace = memory?.pace ?? 'normal';
const indicator = createRoute(REGION_LOOKS.map((look) => look.name));
const resolved = resolveSeed(location.search, memory?.seed, () => {
  const word = new Uint32Array(1);
  crypto.getRandomValues(word);
  return (word[0] ?? 0) / 0x100000000;
});
const seed = resolved.seed;
history.replaceState(null, '', seedURL(location.href, seed));

const mobile = matchMedia('(pointer: coarse)').matches || window.innerWidth < 700;
const quality = createQuality({
  mobile,
  dpr: window.devicePixelRatio || 1,
  maxDpr: mobile ? 2 : 2,
  cores: navigator.hardwareConcurrency || 8,
  memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8,
});

const audio = new OceanAudio(memory?.sound ?? { enabled: false, volume: 0.35 }, seed);
const ui = createUI({
  share: () => `${location.origin}${location.pathname}?seed=${String(seed >>> 0)}`,
  newSeed() {
    const next = nextSeed(seed);
    location.href = seedURL(location.href, next).href;
  },
  sound() {
    audio.enabled = !audio.enabled;
    sync();
    persist();
    ui.announce(audio.enabled ? 'sound on' : 'sound off');
  },
  route(on) {
    routeOn = on;
    indicator.setEnabled(on, world.land.regions.dominantAt(whale.state.x, whale.state.z), journey.path);
    ui.showRoute(indicator.visible, indicator.text);
    persist();
  },
  dives(on) {
    followDives = on;
    persist();
    ui.announce(on ? 'following dives' : 'staying at the surface');
  },
  pace(choice) {
    pace = choice;
    whale.setPace(PACES[pace]);
    persist();
    ui.announce(`${pace} speed`);
  },
  resetView() {
    view.reset();
  },
});

const canvasEl = document.getElementById('space') as HTMLCanvasElement | null;
if (!canvasEl) {
  ui.error('canvas missing');
  throw new Error('canvas missing');
}
const canvas = canvasEl;

// The finish (src/finish.ts) on a GPU with multisampled half floats, a multisampled canvas on other GPUs, a plain
// canvas on CPU renderers. Review can ask for a mode (`?debug=1&frame=finish`).
const askedFrame = debug ? params.get('frame') : null;
const drawMode = frameMode(isFrameMode(askedFrame) ? askedFrame : null);
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: drawMode !== 'plain',
  alpha: false,
  powerPreference: 'low-power',
  outputBufferType: drawMode === 'finish' ? THREE.HalfFloatType : THREE.UnsignedByteType,
});
renderer.setClearColor(0x7a9bb0, 1);
// Counted per frame (`stats()`): the water's mirror and the finish render inside the frame and would reset them.
renderer.info.autoReset = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(quality.ratio);
renderer.autoClear = true;

const scene = new THREE.Scene();
const portrait = window.innerHeight > window.innerWidth;
const camera = new THREE.PerspectiveCamera(portrait ? FOV[1] : FOV[0], 1, 0.5, 12000);
// Layer 1 is the spout mist. Water's mirror camera stays on layer 0, so the plume is not reflected.
camera.layers.enable(1);

let sky: ReturnType<typeof createSky>;
let world: ReturnType<typeof createWorld>;
let whale: ReturnType<typeof createWhale>;
let buildMs = 0;
let birds: ReturnType<typeof createBirds>;
let layout: ReturnType<typeof layoutWorld>;
let rig: FollowCamera;
let underwater: ReturnType<typeof createUnderwater>;
/** Seafloor height (world): pure per seed, so it matches the underwater view's own copy exactly. */
let seafloor: ReturnType<typeof createSeafloor>;
let regionLook: ReturnType<typeof createRegionLook>;
let wake: ReturnType<typeof createWake>;
let weather: ReturnType<typeof createWeather>;
let shipFx: ReturnType<typeof createShipFx>;
/** Whale and ships as obstacles, registered where they are each frame. */
const obstacles = createObstacles();
const syncMovers = createMoverSync(obstacles);
let weatherFx: ReturnType<typeof createWeatherFx>;
/** The swell's own clock: it runs faster as the whale swims faster. */
let swellClock = 0;
const swellSample = { height: 0, slopeX: 0, slopeZ: 0 };
/** Height of the sea at world (x, z) now: what the wakes lie on. */
const surface = (x: number, z: number) => swellAt(x, z, swellClock, swellSample).height;
const fishTime = { value: 0 };
let fishShowcase: ReturnType<typeof createFishShowcase> | null = null;
let finish: ReturnType<typeof createFinish> | null = null;

try {
  const buildStart = performance.now();
  sky = createSky(seed, renderer, scene, environmentFollowsSky());
  layout = layoutWorld(seed, sky.sunAzimuthDeg);
  // yaw 0 marks a follow-camera framing; older orbit framings (yaw = view yaw) are ignored.
  const savedFraming = memory?.framing?.yaw === 0 ? memory.framing : null;
  rig = new FollowCamera(camera, {
    portrait,
    saved: savedFraming,
    // Render coordinates in, world coordinates for the land field.
    groundAt: (x, z) => seafloor.heightAt(x + world.origin.x, z + world.origin.z),
  });
  world = createWorld(seed, layout, scene, {
    sunDirection: sky.sunDirection,
    hazeColor: sky.hazeColor,
    hazeDensity: sky.hazeDensity,
    hazeGradient: { angles: HAZE_ANGLES, colors: sky.hazeGradient },
    // The sky sets how much light the shallows get as the day goes (a low sun lights them less).
    shallowLight: 1,
    waterSize: quality.waterSize,
    landSegments: quality.landSegments,
    detail: detailFor(quality.tier),
    mobile,
    worker: true,
    dissolve: drawMode === 'plain' ? 'dither' : 'coverage',
  });
  // Real ocean depth: the shelf, slope and abyssal plain by distance from the coast.
  seafloor = createSeafloor(seed, world.land, world.land.depthAt);
  regionLook = createRegionLook(world.land.regions);
  // Head along the composed opening view (forward = look direction), so the chase opens on the coast.
  whale = createWhale(seed, layout.whaleHome, {
    tier: quality.tier,
    heading: layout.viewYaw - Math.PI / 2,
    journey: layout.journey,
    floorAt: seafloor.heightAt,
  });
  whale.setPace(PACES[pace]);
  world.root.add(whale.group);
  weather = createWeather(seed, sky.clearCover);
  // A visitor who asked for the indicator sees it on the first change of region, not at once.
  indicator.setEnabled(routeOn, world.land.regions.dominantAt(layout.whaleHome.x, layout.whaleHome.z), 0, false);
  // The whale's wake: its stern, bow and width follow the whale's size, and a deeper body still marks the water.
  wake = createWake({ surface, stern: 5 * LENGTH_SCALE, bow: 6 * LENGTH_SCALE, width: 0.8 * DEPTH_SCALE, depths: [-2.6 * DEPTH_SCALE, -0.9 * DEPTH_SCALE] });
  world.root.add(wake.group);
  shipFx = createShipFx(surface);
  world.root.add(shipFx.group);
  weatherFx = createWeatherFx(seed, quality.tier, world.ocean.waves);
  scene.add(weatherFx.group);
  birds = createBirds(seed, quality.tier);
  world.root.add(birds.group);
  // The floating origin moved: shift the camera with the world so the chase does not jump.
  world.origin.onRecenter((dx, dz) => { rig.shift(dx, dz); });
  underwater = createUnderwater(scene, renderer, { sky, heightAt: world.land.heightAt, depthAt: world.land.depthAt, origin: world.origin, tier: quality.tier, seed, clearInScene: drawMode === 'finish' });
  // Review only (`?debug=1&fish=1`): every fish species in a small school ahead of the camera.
  if (debug && params.get('fish') === '1') fishShowcase = createFishShowcase(fishTime, UNDERWATER_LAYER);
  if (fishShowcase) scene.add(fishShowcase.group);
  finish = drawMode === 'finish' ? createFinish(renderer) : null;
  buildMs = performance.now() - buildStart;
} catch (error) {
  const message = error instanceof Error ? error.message : 'failed to build the scene';
  ui.error(message);
  throw error;
}

/** The reflection environment follows the sky's light on medium and high; phones keep the opening sky's, dimmed at night. */
function environmentFollowsSky(): boolean {
  return quality.tier !== 'low';
}

function resize(): void {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const isPortrait = height > width;
  renderer.setPixelRatio(quality.ratio);
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.fov = isPortrait ? FOV[1] : FOV[0];
  camera.far = 12000;
  camera.updateProjectionMatrix();
  rig.setPortrait(isPortrait);
}

resize();
window.addEventListener('resize', resize);

const view = createViewControls(canvas, rig, (orbiting) => { ui.showReset(orbiting); });

const motion = matchMedia('(prefers-reduced-motion: reduce)');
let routeClock = performance.now();
let time = 0;
let last = performance.now();
let firstFrame = false;
let frame: number | null = null;
let disposed = false;
let lastSave = 0;

function sync(): void {
  ui.sync({ seed, sound: audio.enabled, route: routeOn, dives: followDives, pace });
  audio.sync(!document.hidden).catch(() => {
    // Sound stays off when the context cannot start; the button still reflects the choice.
  });
}

function persist(): void {
  saveMemory(storage, {
    version: VERSION,
    seed,
    sound: audio.settings(),
    framing: { ...rig.framing },
    route: routeOn,
    dives: followDives,
    pace,
  });
}

/** Chase target from the whale, in render coordinates. */
function followWhale(): void {
  const w = whale.state;
  rig.setTarget({ x: w.x - world.origin.x, y: w.y, z: w.z - world.origin.z, heading: w.heading });
}

/** Side-on, close framing so the whale fills ~35–50% of screen width. */
function frameWhaleEvent(kind: 'breach' | 'spout', view: { yawOffset?: number | undefined; pitch?: number | undefined; distance?: number | undefined } = {}): void {
  // Review yaw is relative to the heading (0 = behind); −π/2 is a broadside on the whale's
  // left, and the small negative offset swings toward the head for a three-quarter view.
  // Debug overrides are clamped to the ranges the camera rig itself allows.
  const yaw = -Math.PI / 2 - 0.22 + clamp(view.yawOffset ?? 0, -Math.PI, Math.PI);
  // Close enough that the whale fills ~35–50% of portrait width.
  const distance = clamp(view.distance ?? (kind === 'breach' ? (portrait ? 27 : 17) : portrait ? 24 : 14) * LENGTH_SCALE, 6 * LENGTH_SCALE, 80 * LENGTH_SCALE);
  const pitch = clamp(view.pitch ?? (kind === 'breach' ? 0.12 : 0.02), 0.02, 0.62);
  rig.setReview({ yaw, pitch, distance, minLookY: kind === 'breach' ? 2.5 : 2.4 });
  followWhale();
  // Snap so the first screenshot is already framed.
  rig.snap();
  rig.update(0, time);
}

/** Debug-only camera override for reviewing the underwater view without the follow camera. */
let peekDepth: number | null = null;
/** Debug-only review camera in world coordinates. */
let viewPose: { from: [number, number, number]; to: [number, number, number] } | null = null;
let peekSite: { x: number; y: number; z: number; radius: number } | null = null;

function peekCamera(depth: number): void {
  const w = peekSite ? { ...peekSite, heading: 0.6 } : whale.state;
  const x = w.x - world.origin.x;
  const z = w.z - world.origin.z;
  const side = w.heading + Math.PI / 2;
  const y = -depth;
  const back = peekSite ? 12 + peekSite.radius * 2 : 16 * LENGTH_SCALE;
  camera.position.set(x + Math.cos(side) * back, y, z - Math.sin(side) * back);
  // From below the whale, look straight at it so the surface and Snell's window fill the top of the frame.
  camera.lookAt(x, y + (w.y - y) * (y < w.y ? 1 : 0.45), z);
}

function tick(now: number): void {
  if (disposed) return;
  frame = requestAnimationFrame(tick);
  if (document.hidden) {
    last = now;
    return;
  }
  // The first rAF timestamp can predate `last` (set after the synchronous build); never step backwards.
  const raw = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;
  const dt = motion.matches ? 0 : raw;
  if (!motion.matches) time += dt;

  if (updateQuality(quality, raw * 1000)) {
    birds.setTier(quality.tier);
    weatherFx.setTier(quality.tier);
    world.setWalkerCap(detailFor(quality.tier).walkers);
    sky.setEnvironmentRefresh(environmentFollowsSky());
    renderer.setPixelRatio(quality.ratio);
    resize();
  }

  regionLook.update(whale.state.x, whale.state.z);
  // No lightning under reduced motion.
  const weatherLook = weather.update(dt, time, regionLook.weights, !motion.matches);
  setSea(weatherLook.sea, sky.windAngle);
  sky.setWeather(weatherLook);
  sky.setFog(regionLook.fogTint, regionLook.fogMix, regionLook.fogDensity);
  sky.update(dt, motion.matches ? 0.5 : 1);
  // The sky sets the exposure; display-authored materials and the bloom follow it.
  displayExposure.value = renderer.toneMappingExposure;
  finish?.update(renderer.toneMappingExposure);
  world.ocean.setSky({ haze: sky.hazeColor, exposure: renderer.toneMappingExposure, light: sky.level, shallowLight: sky.shallowLight, sun: sky.sun.intensity / SUN_INTENSITY });
  world.ocean.setWaterColor(regionLook.water);
  world.landStream.setSky(sky.sunDirection, sky.sun.color, sky.hazeGradient, sky.hazeDensity, sky.level);
  world.landStream.setLook(regionLook.hazeDensity * weatherLook.haze, regionLook.land);
  wake.setLight(sky.daylight);
  birds.setMix(regionLook.birds);
  const swell = swellRate(whale.state.speed / TRAVEL_MAX);
  swellClock += dt * swell;
  world.update(whale.state.x, whale.state.z, camera, dt, swellClock);
  world.ocean.update(dt * swell, sky.sunDirection, camera);
  whale.update(dt, time, world.shore);
  syncMovers(whale.state, world.ships.active());
  // Build the ocean's depth ahead of the whale a slice at a time (a couple of milliseconds a frame at most).
  world.land.prefetchDepth(whale.state.x, whale.state.z, 2);
  // The whale rides the swell while near the surface; deeper down it is free of it.
  whale.group.position.y = surface(whale.state.x, whale.state.z) * smoothstep(-7 * DEPTH_SCALE, -1.5 * DEPTH_SCALE, whale.state.y);
  wake.update(whale.state, dt);
  shipFx.update(world.ships.active(), sky.level);
  markJourney();
  if (routeOn) {
    // Six seconds of the clock on the wall, not of the simulation: slow frames and reduced motion do not stretch it.
    indicator.update(Math.min(1, (now - routeClock) / 1000), world.land.regions.dominantAt(whale.state.x, whale.state.z), journey.path);
    ui.showRoute(indicator.visible, indicator.text);
  }
  routeClock = now;
  world.ocean.setWhale(whale.state.x - world.origin.x, whale.state.y, whale.state.z - world.origin.z, whale.state.heading);
  birds.update(time, whale.state.x, whale.state.z, dt, { x: camera.position.x + world.origin.x, y: camera.position.y, z: camera.position.z + world.origin.z }, motion.matches);

  followWhale();
  // Reduced motion keeps the eye at the surface, as does the viewer's choice.
  rig.setStayAtSurface(!followDives || motion.matches);
  view.update(motion.matches);
  rig.update(dt, time, motion.matches);
  if (peekDepth !== null) peekCamera(peekDepth);
  if (viewPose) {
    camera.position.set(viewPose.from[0] - world.origin.x, viewPose.from[1], viewPose.from[2] - world.origin.z);
    camera.lookAt(viewPose.to[0] - world.origin.x, viewPose.to[1], viewPose.to[2] - world.origin.z);
  }

  world.ocean.setSea(swellClock, weatherLook.wind, camera.position.y);
  weatherFx.update({
    camera,
    time,
    rain: weatherLook.rain,
    wind: weatherLook.wind,
    sea: weatherLook.sea,
    windAngle: sky.windAngle,
    light: sky.level,
    height: renderer.domElement.height,
  });
  const signal = underwater.update(dt, time, camera, whale.state);
  fishTime.value = time;
  fishShowcase?.follow(camera);
  audio.update(dt, { camera, signal, whale: whale.state, ships: world.ships.active(), shore: world.shore, origin: world.origin, weather: weatherLook });
  renderer.info.reset();
  renderer.render(scene, camera);
  if (!firstFrame) {
    // The first frame of the sea, for load-time checks.
    firstFrame = true;
    performance.mark('calm-first-frame');
  }

  if (now - lastSave > 4000) {
    lastSave = now;
    persist();
  }
}

/**
 * Compiles what the opening frame does not draw yet (the land's full tiles dissolving in over the bare ones, people
 * and animals) before it, by drawing each once as a single degenerate point, so their first use a few seconds later
 * does not stall a frame.
 */
function warm(): void {
  const point = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const stage = new THREE.Scene();
  for (const material of world.laterMaterials) {
    const mesh = new THREE.Mesh(point, material);
    mesh.frustumCulled = false;
    stage.add(mesh);
  }
  renderer.render(stage, camera);
  point.dispose();
}

function start(): void {
  warm();
  ui.ready();
  sync();
  persist();
  last = performance.now();
  frame = requestAnimationFrame(tick);
}

document.addEventListener('visibilitychange', () => {
  sync();
  if (!document.hidden) last = performance.now();
});

if (debug) {
  const review: CalmReview = {
    get time() {
      return time;
    },
    advance(seconds: number) {
      if (Number.isFinite(seconds)) time += Math.min(3600, Math.max(0, seconds));
    },
    travel(seconds: number) {
      for (let t = 0; t < Math.min(3600, Math.max(0, seconds || 0)); t += 1 / 30) {
        time += 1 / 30;
        swellClock += swellRate(whale.state.speed / TRAVEL_MAX) / 30;
        world.update(whale.state.x, whale.state.z, camera, 1 / 30, swellClock);
        whale.update(1 / 30, time, world.shore);
        markJourney();
      }
      rig.snap();
    },
    forceBreach(at?: number) {
      whale.forcePhase('breach', typeof at === 'number' && Number.isFinite(at) ? at : undefined);
      frameWhaleEvent('breach');
    },
    forceSpout() {
      whale.forcePhase('spout');
      frameWhaleEvent('spout');
    },
    frameWhale(kind: 'breach' | 'spout' = 'breach', yawOffset?: number, pitch?: number, distance?: number) {
      const finite = (v?: number) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      frameWhaleEvent(kind, { yawOffset: finite(yawOffset), pitch: finite(pitch), distance: finite(distance) });
    },
    setWaterVisible(visible: boolean) {
      world.ocean.mesh.visible = visible;
    },
    setWhaleVisible(visible: boolean) {
      whale.group.visible = visible;
    },
    setLandVisible(visible: boolean) {
      world.landStream.group.visible = visible;
    },
    setShipsVisible(visible: boolean) {
      world.ships.setVisible(visible);
    },
    forceDeepDive(at?: number) {
      whale.forcePhase('deep', typeof at === 'number' && Number.isFinite(at) ? at : undefined);
    },
    forceWhale(phase: WhalePhase, at?: number) {
      if (!Object.hasOwn(PHASE_LEN, phase)) return;
      whale.forcePhase(phase, typeof at === 'number' && Number.isFinite(at) ? at : undefined);
    },
    peekUnderwater(depth: number | null, site?: boolean) {
      peekDepth = typeof depth === 'number' && Number.isFinite(depth) ? clamp(depth, -20, 40) : null;
      // Review a swarm: the nearest feed site, viewed from its side at the given depth.
      peekSite = site ? (feedSitesNear(seed, whale.state.x, whale.state.z, 2400, underwater.seafloor.heightAt)[0] ?? null) : null;
    },
    frame(yaw: number, pitch: number, distance: number) {
      if (![yaw, pitch, distance].every(Number.isFinite)) return;
      yaw = clamp(yaw, -4 * Math.PI, 4 * Math.PI);
      pitch = clamp(pitch, 0.02, 0.62);
      distance = clamp(distance, 6 * LENGTH_SCALE, 80 * LENGTH_SCALE);
      rig.setReview({ yaw, pitch, distance });
      rig.snap();
    },
    follow() {
      rig.setReview(null);
    },
    setDay(day: number) {
      if (!Number.isFinite(day)) return;
      sky.setDay(day);
      // A visitor's reflections would have caught up with the sky within ENV_REFRESH; a review jump catches up now.
      if (environmentFollowsSky()) sky.refreshEnvironment();
    },
    setWeather(state: WeatherState) {
      weather.set(state);
    },
    setSea(level: number | null) {
      weather.setSea(typeof level === 'number' && Number.isFinite(level) ? level : null);
    },
    jumpTo(x: number, z: number) {
      if (![x, z].every(Number.isFinite)) return;
      // The nearest spot with room round it: a spiral out from the asked-for one.
      let best = { x, z };
      search: for (let ring = 0; ring < 40; ring++) {
        for (let k = 0; k < Math.max(1, ring * 8); k++) {
          const a = (k / Math.max(1, ring * 8)) * Math.PI * 2;
          const px = x + Math.cos(a) * ring * 200;
          const pz = z + Math.sin(a) * ring * 200;
          if (world.land.clearance(px, pz) > 400) {
            best = { x: px, z: pz };
            break search;
          }
        }
      }
      whale.place(best.x, best.z);
      world.landStream.prime(best.x, best.z);
      world.land.nav.prefetch(best.x, best.z, 1100, Infinity);
      // The jump is not swimming: the distance travelled starts again from here.
      journey.x = journey.z = NaN;
      markJourney();
      rig.snap();
    },
    life(radius: number) {
      const life = createLandLife(world.land);
      const { x, z } = whale.state;
      radius = clamp(radius, 0, 12000);
      const out: ReturnType<CalmReview['life']> = [];
      const { heightAt, maskAt } = world.land;
      const EYE = 9;
      // Open water nearest 150 m out, from where nothing stands between the eye and the subject.
      const vantage = (px: number, pz: number, py: number): [number, number, number] | null => {
        let best: [number, number, number] | null = null;
        let score = Infinity;
        for (let k = 0; k < 32; k++) {
          const a = (k / 32) * Math.PI * 2;
          for (let d = 60; d <= 400; d += 20) {
            const cx = px + Math.cos(a) * d;
            const cz = pz + Math.sin(a) * d;
            if (Math.abs(d - 150) >= score || maskAt(cx, cz) > -0.02 || heightAt(cx, cz) > -1) continue;
            let clear = true;
            for (let t = 0.05; t < 0.97 && clear; t += 0.02) clear = heightAt(cx + (px - cx) * t, cz + (pz - cz) * t) < EYE + (py + 3 - EYE) * t - 1;
            if (clear) {
              best = [cx, EYE, cz];
              score = Math.abs(d - 150);
            }
          }
        }
        return best;
      };
      const add = (kind: 'town' | 'herd', px: number, pz: number, count: number) => {
        if (Math.hypot(px - x, pz - z) > radius) return;
        const py = heightAt(px, pz);
        out.push({ kind, x: px, y: py, z: pz, count, vantage: vantage(px, pz, py) });
      };
      for (let j = Math.floor((z - radius) / TOWN_CELL); j <= Math.floor((z + radius) / TOWN_CELL); j++) {
        for (let i = Math.floor((x - radius) / TOWN_CELL); i <= Math.floor((x + radius) / TOWN_CELL); i++) {
          const town = life.town(i, j);
          if (town) add('town', town.x, town.z, town.houses.length);
        }
      }
      for (let j = Math.floor((z - radius) / HERD_CELL); j <= Math.floor((z + radius) / HERD_CELL); j++) {
        for (let i = Math.floor((x - radius) / HERD_CELL); i <= Math.floor((x + radius) / HERD_CELL); i++) {
          const herd = life.herd(i, j);
          if (herd.length) add('herd', item(herd, 0).x, item(herd, 0).z, herd.length);
        }
      }
      return out.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    },
    peak(near: number, far: number) {
      const { x, z } = whale.state;
      let best = { x, y: -Infinity, z };
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        for (let d = clamp(near, 0, 12000); d <= clamp(far, 0, 12000); d += 200) {
          const px = x + Math.cos(a) * d;
          const pz = z + Math.sin(a) * d;
          const py = world.land.heightAt(px, pz);
          if (py > best.y) best = { x: px, y: py, z: pz };
        }
      }
      return best;
    },
    view(from, to) {
      const finite = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
      if (!finite(from) || !finite(to)) {
        viewPose = null;
        return;
      }
      viewPose = { from, to };
      whale.place(from[0], from[2]);
      world.landStream.prime(from[0], from[2]);
      journey.x = journey.z = NaN;
      markJourney();
    },
    setRoute(on: boolean) {
      routeOn = on;
      indicator.setEnabled(routeOn, world.land.regions.dominantAt(whale.state.x, whale.state.z), journey.path);
      ui.showRoute(indicator.visible, indicator.text);
      sync();
    },
    stats() {
      const size = whale.measure();
      const flock = birds.stats();
      return {
        seed,
        time,
        tier: quality.tier,
        dpr: quality.ratio,
        phase: whale.state.phase,
        phaseT: whale.state.phaseT,
        whale: [whale.state.x, whale.state.y, whale.state.z],
        whaleHeading: whale.state.heading,
        whaleSize: [size.x, size.y, size.z],
        whaleDetail: whale.detail(),
        cam: [camera.position.x, camera.position.y, camera.position.z],
        focus: [rig.lookAt.x, rig.lookAt.y, rig.lookAt.z],
        dist: rig.distance,
        camMode: rig.mode,
        buildMs: Math.round(buildMs),
        ships: world.ships.active().length,
        obstacles: obstacles.size,
        birds: flock.birds,
        birdDraws: flock.draws,
        birdTriangles: flock.triangles,
        ...world.stats(),
        whaleSkinMs: Math.round(skinMs),
        path: journey.path,
        revisit: journey.fixes.length ? journey.back / (journey.fixes.length / 2) : 0,
        region: world.land.regions.dominantAt(whale.state.x, whale.state.z),
        regionName: item(REGION_LOOKS, world.land.regions.dominantAt(whale.state.x, whale.state.z)).name,
        landNear: landWithin(whale.state.x, whale.state.z, 4500),
        net: Math.hypot(journey.x - journey.fromX, journey.z - journey.fromZ) || 0,
        speed: whale.state.speed,
        behavior: whale.state.behavior,
        exposure: renderer.toneMappingExposure,
        frame: drawMode,
        dayPhase: sky.phase().name,
        stars: sky.stars,
        day: sky.phase().day,
        sunElevation: (Math.asin(sky.sunDirection.y) * 180) / Math.PI,
        sun: [sky.sunDirection.x, sky.sunDirection.y, sky.sunDirection.z],
        weather: weather.target(),
        cloudCover: weather.look.coverage,
        sea: weather.look.sea,
        rain: weather.look.rain,
        wind: weather.look.wind,
        flash: weather.look.flash,
        glow: sky.glow,
        weatherDraws: weatherFx.draws(),
        fogDensity: (scene.fog as THREE.FogExp2).density,
        fov: camera.fov,
        wakeDraws: wake.draws(),
        addedDraws: wake.draws() + (sky.stars > 0.01 ? 1 : 0) + shipFx.draws() + weatherFx.draws(),
        wakeLength: wake.length(),
        envMs: sky.environment().ms,
        envRefreshes: sky.environment().count,
        route: indicator.visible ? indicator.text : '',
        swellClock,
        // The last frame, mirror and finish included.
        draws: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        submersion: underwater.signal.submersion,
        depth: underwater.signal.depth,
        underwaterLife: Object.values(underwater.stats()),
        feedSites: underwater.sites.map((site) => site.id),
        audio: audio.stats(),
      };
    },
  };
  (window as unknown as { __calmReview: CalmReview }).__calmReview = review;
  const at = params.get('at');
  if (at === 'breach') {
    time = 0;
    whale.forcePhase('breach');
    frameWhaleEvent('breach');
  } else if (at === 'breach-start') {
    // Review only: rise from depth so the exit splash and the full arc can be watched.
    time = 0;
    whale.forcePhase('breach', 0);
    frameWhaleEvent('breach');
  } else if (at === 'spout') {
    time = 0;
    whale.forcePhase('spout');
    frameWhaleEvent('spout');
  }
}

start();

window.addEventListener('pagehide', () => {
  disposed = true;
  if (frame !== null) cancelAnimationFrame(frame);
  persist();
  audio.dispose();
  ui.dispose();
  view.dispose();
  sky.dispose();
  whale.dispose();
  wake.dispose();
  shipFx.dispose();
  weatherFx.dispose();
  world.dispose();
  birds.dispose();
  underwater.dispose();
  fishShowcase?.dispose();
  finish?.dispose();
  renderer.dispose();
});
