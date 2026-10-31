import { test, expect } from 'vitest';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DAY, DAY_SECONDS, ENV_REFRESH, createSky, pickTimeOfDay, type SkyHandle } from '../src/sky.js';
import { WEATHER, createWeather } from '../src/weather.js';
import { createRoute, ROUTE_SECONDS } from '../src/route.js';
import { REGION_LOOKS } from '../src/regions.js';
import { loadMemory, saveMemory, validateMemory, STORAGE_KEY, VERSION } from '../src/persistence.js';
import { headlessRenderer } from '../tools/headless-renderer.js';

/** A sky with no GPU: the environment refresh fails quietly, as it would without WebGL, but is counted. */
function makeSky(seed: number): { sky: SkyHandle; renderer: THREE.WebGLRenderer; scene: THREE.Scene } {
  const renderer = headlessRenderer();
  const scene = new THREE.Scene();
  return { sky: createSky(seed, renderer, scene), renderer, scene };
}

const fogColor = (scene: THREE.Scene) => (scene.fog as THREE.FogExp2).color;
const luma = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;

test('the day starts at the seed\'s own time, runs through all five presets in 40 minutes and comes round again', () => {
  for (const seed of [42, 7, 1234, 99]) {
    const { sky } = makeSky(seed);
    assert.equal(sky.phase().name, pickTimeOfDay(seed));
    const seen = new Set<string>();
    let lowest = Infinity;
    let highest = -Infinity;
    const first = sky.sunDirection.clone();
    for (let t = 0; t < DAY_SECONDS; t++) {
      sky.update(1);
      seen.add(sky.phase().name);
      lowest = Math.min(lowest, sky.sunDirection.y);
      highest = Math.max(highest, sky.sunDirection.y);
    }
    assert.equal(seen.size, DAY.length, `seed ${String(seed)} saw ${[...seen].join(', ')}`);
    assert.ok(lowest < -0.1, `the sun sets (lowest ${lowest.toFixed(2)})`);
    assert.ok(highest > 0.3);
    // A whole period on, the sun is where it began (the wobble aside).
    assert.ok(sky.sunDirection.distanceTo(first) < 0.02, `${sky.sunDirection.distanceTo(first).toFixed(3)} from where it began`);
    sky.dispose();
  }
});

test('exposure and fog colour change by at most 1 percent a second through a whole day', () => {
  for (const seed of [42, 7, 1234, 99]) {
    const { sky, renderer, scene } = makeSky(seed);
    let exposure = renderer.toneMappingExposure;
    const fog = fogColor(scene).clone();
    let density = (scene.fog as THREE.FogExp2).density;
    let worst = 0;
    let worstFog = 0;
    let worstDensity = 0;
    for (let t = 0; t < DAY_SECONDS; t++) {
      sky.update(1);
      worst = Math.max(worst, Math.abs(renderer.toneMappingExposure - exposure) / exposure);
      for (const channel of ['r', 'g', 'b'] as const) {
        const a = Math.max(fog[channel], 0.02);
        worstFog = Math.max(worstFog, Math.abs(fogColor(scene)[channel] - fog[channel]) / a);
      }
      const now = (scene.fog as THREE.FogExp2).density;
      worstDensity = Math.max(worstDensity, Math.abs(now - density) / density);
      exposure = renderer.toneMappingExposure;
      fog.copy(fogColor(scene));
      density = now;
    }
    assert.ok(worst <= 0.01, `seed ${String(seed)}: exposure moved ${(100 * worst).toFixed(2)} percent in a second`);
    assert.ok(worstFog <= 0.01, `seed ${String(seed)}: fog colour moved ${(100 * worstFog).toFixed(2)} percent in a second`);
    assert.ok(worstDensity <= 0.01, `seed ${String(seed)}: fog density moved ${(100 * worstDensity).toFixed(2)} percent in a second`);
    sky.dispose();
  }
});

test('the night is dark and quiet: the sun gives no light, the sea and land dim, the haze darkens', () => {
  const { sky } = makeSky(42);
  const noon = { level: 0, haze: 0, sunLight: 0 };
  sky.setDay(0);
  const day = pickTimeOfDay(42);
  assert.ok(sky.level === 1 && sky.lightBase.sun.intensity > 1, `${day} should be bright`);
  noon.haze = luma(sky.hazeColor);
  // Four presets on from any start lies the night.
  sky.setDay(((DAY.indexOf('night') - DAY.indexOf(day) + DAY.length) % DAY.length) / DAY.length);
  assert.equal(sky.phase().name, 'night');
  expect(sky.level).toBeLessThan(0.2);
  assert.equal(sky.lightBase.sun.intensity, 0);
  assert.ok(sky.daylight < 0.2);
  assert.ok(luma(sky.hazeColor) < noon.haze * 0.2, 'the haze darkens');
  assert.ok(sky.hemi.intensity > 0.2 && sky.ambient.intensity > 0.2, 'the moon leaves a cool fill');
  assert.ok(sky.sunDirection.y < 0);
});

test('lights are written once per frame from the sky\'s own record, so the underwater dimming has a base to start from', () => {
  const { sky } = makeSky(7);
  for (let i = 0; i < 100; i++) sky.update(1);
  assert.equal(sky.sun.intensity, sky.lightBase.sun.intensity);
  assert.equal(sky.hemi.intensity, sky.lightBase.hemi.intensity);
  assert.ok(sky.sun.color.equals(sky.lightBase.sun.color));
  sky.sun.intensity = 0;
  sky.update(1);
  assert.equal(sky.sun.intensity, sky.lightBase.sun.intensity);
});

test('the environment map refreshes at most every 90 s on medium and high, and never on low', () => {
  const run = (on: boolean) => {
    const { sky } = makeSky(42);
    sky.setEnvironmentRefresh(on);
    const built = sky.environment().count;
    const at: number[] = [];
    for (let t = 1; t <= 400; t++) {
      const before = sky.environment().count;
      sky.update(1);
      if (sky.environment().count > before) at.push(t);
    }
    return { built, at };
  };
  const low = run(false);
  assert.equal(low.built, 1, 'the sky\'s first environment is built at the start');
  assert.deepEqual(low.at, []);
  const high = run(true);
  assert.deepEqual(high.at, [90, 180, 270, 360], 'refreshed on the dot, never sooner');
  assert.equal(ENV_REFRESH, 90);
  // A drop to low rebuilds the environment once, without the sunset, to keep for the rest of the visit.
  const { sky } = makeSky(42);
  sky.setEnvironmentRefresh(true);
  const before = sky.environment().count;
  sky.setEnvironmentRefresh(false);
  assert.equal(sky.environment().count, before + 1);
  sky.setEnvironmentRefresh(false);
  assert.equal(sky.environment().count, before + 1, 'switching off twice builds once');
});

test('a kept environment dims with the night instead of lighting it like the day it was built in', () => {
  const night = (DAY.indexOf('night') - DAY.indexOf(pickTimeOfDay(42)) + DAY.length) % DAY.length / DAY.length;
  // Read through a call: the first assertion would otherwise narrow the field to its value.
  const intensity = (made: { scene: THREE.Scene }): number => made.scene.environmentIntensity;
  const kept = makeSky(42);
  kept.sky.setDay(0);
  assert.equal(intensity(kept), 1, 'by day it is as built');
  kept.sky.setDay(night);
  assert.ok(intensity(kept) < 0.3, `night keeps ${String(intensity(kept))} of it`);
  const followed = makeSky(42);
  followed.sky.setEnvironmentRefresh(true);
  followed.sky.setDay(night);
  assert.equal(intensity(followed), 1, 'a followed environment is the night sky itself');
});

test('reduced motion halves the cloud drift and slows the day', () => {
  const full = makeSky(42);
  const calm = makeSky(42);
  for (let i = 0; i < 600; i++) {
    full.sky.update(1, 1);
    calm.sky.update(1, 0.5);
  }
  const time = (s: SkyHandle) => item((s.sky.material).uniforms, 'time').value as number;
  assert.equal(time(calm.sky), time(full.sky) / 2);
  const advance = (s: SkyHandle) => {
    const p = s.phase();
    return DAY.indexOf(p.name) + (p.day * DAY.length - Math.round(p.day * DAY.length));
  };
  assert.ok(advance(calm.sky) !== advance(full.sky) || calm.sky.phase().name !== full.sky.phase().name);
});

test('overcast keeps the horizon calm: the fog is no brighter than in clear weather, and the land haze stays light enough to read within 2 km', () => {
  for (const seed of [42, 7]) {
    const { sky, scene } = makeSky(seed);
    const weather = createWeather(seed, sky.clearCover);
    for (let d = 0; d < DAY.length; d++) {
      sky.setDay(d / DAY.length);
      weather.set('clear');
      sky.setWeather(weather.look);
      sky.update(0);
      const clear = luma(fogColor(scene));
      const clearHaze = luma(sky.hazeColor);
      weather.set('overcast');
      sky.setWeather(weather.look);
      sky.update(0);
      assert.ok(luma(fogColor(scene)) <= clear * 1.001 + 1e-9, 'overcast fog is brighter than clear');
      assert.ok(luma(sky.hazeColor) <= clearHaze * 1.001 + 1e-9, 'overcast haze is brighter than clear');
      // The sea fog (FogExp2) and the land's haze (its shader's own form): how much of a coast 2 km away shows through.
      const density = (scene.fog as THREE.FogExp2).density;
      assert.ok(Math.exp(-((density * 2000) ** 2)) > 0.3, `the sea fog hides a coast at 2 km (${String(density)})`);
      for (const look of REGION_LOOKS) {
        const seen = (factor: number) => Math.exp(-2000 / 9000 - (2000 * sky.hazeDensity * look.hazeDensity * factor) ** 2);
        assert.ok(seen(WEATHER.overcast.haze) >= 0.75 * seen(1), `overcast thickens the haze too far in ${look.name}`);
        if (look.name !== 'Polar') assert.ok(seen(WEATHER.overcast.haze) > 0.2, `${look.name}'s coast at 2 km shows ${seen(WEATHER.overcast.haze).toFixed(2)}`);
      }
    }
    sky.dispose();
  }
});

test('the route indicator: off by default, in on a region change, out after six seconds, and the setting is kept', () => {
  assert.equal(validateMemory({ version: VERSION, seed: 5 }), true);
  assert.equal(loadMemory(null)?.route, undefined);
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as unknown as Storage;
  assert.equal(loadMemory(storage), null);
  assert.equal((loadMemory(storage)?.route ?? false), false, 'a new visitor sees no indicator');
  saveMemory(storage, { version: VERSION, seed: 5, route: true });
  assert.equal(loadMemory(storage)?.route, true);
  store.set(STORAGE_KEY, JSON.stringify({ version: VERSION, seed: 5, route: 'yes' }));
  assert.equal(loadMemory(storage), null, 'a bad flag is ignored');

  const names = REGION_LOOKS.map((look) => look.name);
  const route = createRoute(names);
  route.update(1, 0, 100);
  assert.equal(route.visible, false, 'off by default');
  route.setEnabled(true, 0, 1200, false);
  route.update(1, 0, 1300);
  assert.equal(route.visible, false, 'on, but nothing has changed yet');
  route.update(1, 1, 1500);
  assert.equal(route.visible, true);
  assert.equal(route.text, 'Tropical · 1.5 km');
  for (let t = 0; t < ROUTE_SECONDS - 2; t++) route.update(1, 1, 1600 + t * 100);
  assert.equal(route.visible, true, 'still there before six seconds');
  route.update(1.5, 1, 2300);
  assert.equal(route.visible, false, 'gone after six seconds');
  route.update(1, 1, 2400);
  assert.equal(route.visible, false);
  route.update(1, 2, 2400);
  assert.equal(route.visible, true, 'back on the next change');
  assert.equal(route.text, 'Polar · 2.4 km');
  route.setEnabled(false, 2, 2500);
  route.update(1, 3, 2600);
  assert.equal(route.visible, false);
  route.setEnabled(true, 3, 120000);
  assert.equal(route.text, 'Deep blue · 120 km');
});

import { STARS_FROM, STARS_FULL } from '../src/sky.js';
import { item } from '../src/item.js';

test('stars fade in as the sun sets, fade out as it rises, and thick cloud hides them', () => {
  const { sky } = makeSky(42);
  const weather = createWeather(42, sky.clearCover);
  sky.setWeather(weather.look);
  let seenFull = false;
  let seenNone = false;
  let last = sky.stars;
  let biggest = 0;
  for (let t = 0; t < DAY_SECONDS; t++) {
    sky.update(1);
    const elevation = (Math.asin(sky.sunDirection.y) * 180) / Math.PI;
    if (elevation < STARS_FULL - 1) {
      assert.ok(sky.stars > 0.99, `stars ${sky.stars.toFixed(2)} with the sun at ${elevation.toFixed(1)} degrees`);
      seenFull = true;
    }
    if (elevation > STARS_FROM + 1) {
      assert.equal(sky.stars, 0);
      seenNone = true;
    }
    biggest = Math.max(biggest, Math.abs(sky.stars - last));
    last = sky.stars;
  }
  assert.ok(seenFull && seenNone);
  assert.ok(biggest < 0.05, `stars changed by ${biggest.toFixed(3)} in a second`);
  // Overcast puts them out; the sky holds one points object of the stars.
  sky.setDay((DAY.indexOf('night') - DAY.indexOf(pickTimeOfDay(42)) + DAY.length) % DAY.length / DAY.length);
  weather.set('overcast');
  sky.setWeather(weather.look);
  sky.update(0);
  assert.ok(sky.stars < 0.2, `${String(sky.stars)} under overcast`);
  weather.set('clear');
  sky.setWeather(weather.look);
  sky.update(0);
  assert.ok(sky.stars > 0.9);
  const points = sky.sky.children.filter((child) => child instanceof THREE.Points);
  assert.equal(points.length, 1);
  // Held still without time passing, as under reduced motion.
  const turn = (points[0] as THREE.Points).rotation.y;
  sky.update(0, 0.5);
  assert.equal((points[0] as THREE.Points).rotation.y, turn);
});
