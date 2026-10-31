import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  FLASH_CELL,
  FLASH_RISE,
  LADDER,
  WEATHER,
  WEATHER_STATES,
  createWeather,
  flashAt,
  severityAt,
  weatherSpan,
  weatherTrack,
  type WeatherLook,
  type WeatherState,
} from '../src/weather.js';
import { FLASH_LIFT, createSky } from '../src/sky.js';
import { SEA_MAX, SEA_WAVES, SWELL_WAVES, packWaves, setSea, swellAt } from '../src/swell.js';
import { rainGain, seaGain, weatherWindGain } from '../src/audio-mix.js';
import { FX_COUNTS, RAIN_BOX, rainVelocity, stepRain } from '../src/weather-fx.js';
import { seaGeometry } from '../src/ocean.js';
import type { RegionWeights } from '../src/regions.js';
import { item, last } from '../src/item.js';
import { headlessRenderer } from '../tools/headless-renderer.js';

const REGION: RegionWeights[] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const KEYS = ['coverage', 'density', 'fog', 'haze', 'sun', 'grey', 'rain', 'wind', 'dark', 'sea'] as const;
const RANGE = Object.fromEntries(
  KEYS.map((k) => [k, Math.max(...Object.values(WEATHER).map((s) => s[k])) - Math.min(...Object.values(WEATHER).map((s) => s[k]))]),
) as Record<(typeof KEYS)[number], number>;

/** The regions in turn, 1700 s in each, blended over 300 s as the whale swims through them. */
function walk(t: number, out: RegionWeights): RegionWeights {
  const at = t / 1700;
  const here = Math.floor(at) % 4;
  const blend = Math.min(1, Math.max(0, (at - Math.floor(at)) * 1700 - 1400) / 300);
  out.fill(0);
  out[here] = 1 - blend;
  out[(here + 1) % 4] = blend;
  return out;
}

/** Runs a seed's weather for `hours` at `step` seconds, walking through the regions; calls `each` every step. */
function run(seed: number, hours: number, step: number, each: (look: WeatherLook, state: WeatherState, t: number) => void, region?: number): void {
  const w = createWeather(seed, WEATHER.clear.coverage);
  const weights: RegionWeights = [0, 0, 0, 0];
  for (let t = step; t <= hours * 3600; t += step) {
    w.update(step, t, region === undefined ? walk(t, weights) : item(REGION, region));
    each(w.look, w.target(), t);
  }
}

test('six weather states, and every one of them comes in ten hours of a seed', () => {
  assert.deepEqual([...WEATHER_STATES].sort(), ['clear', 'fog', 'hazy', 'overcast', 'rain', 'storm']);
  for (const seed of [42, 7, 1234]) {
    const seen = new Set<string>();
    run(seed, 10, 5, (_, state) => seen.add(state));
    assert.equal(seen.size, 6, `seed ${String(seed)} saw only ${[...seen].join(', ')}`);
  }
});

test('the weather is a pure function of seed, clock and region, and each seed holds it for its own while', () => {
  const a = weatherTrack(42);
  const b = weatherTrack(42);
  // Sampled out of order on one, in order on the other.
  for (const t of [9000, 10, 3600, 1234.5]) assert.equal(a.ladder(t), weatherTrack(42).ladder(t));
  for (let t = 0; t < 20000; t += 37) {
    assert.equal(severityAt(a, t, item(REGION, 2)), severityAt(b, t, item(REGION, 2)));
    assert.equal(a.bank(t), b.bank(t));
    assert.equal(a.swell(t), b.swell(t));
  }
  const spans = [1, 2, 3, 4, 5, 6].map(weatherSpan);
  assert.ok(new Set(spans.map(Math.round)).size > 3, 'spans vary by seed');
  for (const span of spans) assert.ok(span >= 200 && span <= 360);
  const looks: number[][] = [];
  for (let k = 0; k < 2; k++) {
    const trace: number[] = [];
    run(42, 1, 1, (look) => trace.push(look.coverage, look.sea, look.flash));
    looks.push(trace);
  }
  assert.deepEqual(looks[0], looks[1]);
});

test('the weather moves a rung at a time and never jumps: no look value moves 2 percent of its range in a second', () => {
  for (const seed of [42, 7, 11]) {
    const track = weatherTrack(seed);
    for (let k = 0; k < 200; k++) {
      const a = track.ladder(k * track.span);
      const b = track.ladder((k + 1) * track.span);
      assert.ok(Math.abs(a - b) <= 1 / (LADDER.length - 1) + 1e-9, `seed ${String(seed)} knot ${String(k)} skipped a rung`);
    }
    let previous: WeatherLook | null = null;
    const worst = Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<(typeof KEYS)[number], number>;
    run(seed, 2, 1, (look) => {
      if (previous) for (const k of KEYS) worst[k] = Math.max(worst[k], Math.abs(look[k] - previous[k]) / RANGE[k]);
      previous = { ...look };
    });
    for (const k of KEYS) assert.ok(worst[k] <= 0.02, `seed ${String(seed)}: ${k} moved ${(100 * worst[k]).toFixed(2)} percent of its range in a second`);
  }
});

test('the opening is clear for at least a minute, in every region', () => {
  for (const seed of [42, 7, 1234, 99]) {
    for (const region of [0, 1, 2, 3]) {
      run(seed, 60 / 3600, 1, (look, state) => {
        assert.equal(state, 'clear');
        assert.equal(look.rain, 0);
      }, region);
    }
  }
});

test('polar seas are rougher and foggier than tropical ones', () => {
  for (const seed of [42, 7]) {
    const mean = (region: number) => {
      let sea = 0;
      let fog = 0;
      let n = 0;
      run(seed, 10, 10, (look, state) => {
        sea += look.sea;
        fog += state === 'fog' ? 1 : 0;
        n++;
      }, region);
      return { sea: sea / n, fog: fog / n };
    };
    const polar = mean(2);
    const tropical = mean(1);
    assert.ok(polar.sea > tropical.sea, `seed ${String(seed)}: polar sea ${polar.sea.toFixed(3)}, tropical ${tropical.sea.toFixed(3)}`);
    assert.ok(polar.fog > tropical.fog);
  }
});

test('seas build and fall slowly, and a distant swell can arrive under a clear sky', () => {
  let swellUnderClear = false;
  for (const seed of [42, 7, 1234]) {
    let last = 0;
    run(seed, 6, 1, (look, state) => {
      assert.ok(Math.abs(look.sea - last) <= 0.01 + 1e-9, 'the sea moved more than 1 percent in a second');
      last = look.sea;
      if (state === 'clear' && look.sea > 0.15) swellUnderClear = true;
    });
  }
  assert.ok(swellUnderClear);
});

test('lightning is soft and spaced: one flash per six seconds at most, rising over 0.15 s, never under reduced motion', () => {
  const starts: number[] = [];
  let prev = 0;
  let rising = 0;
  const dt = 1 / 60;
  for (let t = 0; t < 3600; t += dt) {
    const f = flashAt(42, t, 1);
    assert.ok(f >= 0 && f <= 1);
    if (prev === 0 && f > 0) {
      starts.push(t);
      rising = f;
    }
    if (f > 0 && starts.length && t - last(starts) < FLASH_RISE) assert.ok(f - prev <= dt / FLASH_RISE + 1e-6, 'a flash jumped up');
    prev = f;
  }
  assert.ok(rising <= dt / FLASH_RISE + 1e-6);
  assert.ok(starts.length > 60, `${String(starts.length)} flashes in an hour of storm`);
  for (let i = 1; i < starts.length; i++) assert.ok((starts[i] ?? 0) - (starts[i - 1] ?? 0) >= FLASH_CELL, 'two flashes too close together');
  assert.equal(flashAt(42, 1000, 0), 0);
  // The weather turns them off when asked (reduced motion), even in a storm.
  const w = createWeather(42);
  w.set('storm');
  let any = 0;
  for (let t = 0; t < 600; t += 0.05) any = Math.max(any, w.update(0.05, t, item(REGION, 0), false).flash);
  assert.equal(any, 0);
  for (let t = 0; t < 600 && any === 0; t += 0.05) any = w.update(0.05, t, item(REGION, 0), true).flash;
  assert.ok(any > 0, 'a storm flashes when motion is allowed');
});

function makeSky(seed: number) {
  const renderer = headlessRenderer();
  return { sky: createSky(seed, renderer, new THREE.Scene()), renderer };
}

test('a lightning flash lifts the sky\'s light by at most 35 percent', () => {
  const { sky } = makeSky(42);
  const w = createWeather(42);
  w.set('storm');
  sky.setWeather(w.look);
  sky.update(0);
  const base = sky.lightBase.hemi.intensity;
  sky.setWeather({ ...w.look, flash: 1 });
  sky.update(0);
  assert.ok(sky.lightBase.hemi.intensity <= base * (1 + FLASH_LIFT) + 1e-9);
  assert.ok(sky.lightBase.hemi.intensity > base);
  sky.dispose();
});

test('a storm darkens the view; sunsets glow under a clear sky and go grey under overcast', () => {
  const { sky, renderer } = makeSky(42);
  const w = createWeather(42);
  w.set('clear');
  sky.setWeather(w.look);
  sky.update(0);
  const clearExposure = renderer.toneMappingExposure;
  w.set('storm');
  sky.setWeather(w.look);
  sky.update(0);
  assert.ok(renderer.toneMappingExposure < clearExposure * 0.75);

  // Find a moment in the day with the sun 2 to 4 degrees up.
  let found = false;
  for (let d = 0; d < 1 && !found; d += 0.002) {
    sky.setDay(d);
    if (Math.abs((Math.asin(sky.sunDirection.y) * 180) / Math.PI - 3) > 1) continue;
    found = true;
    w.set('clear');
    sky.setWeather(w.look);
    sky.update(0);
    const clear = sky.horizonColor.r / sky.horizonColor.b;
    assert.ok(sky.glow > 0.5, `glow ${String(sky.glow)}`);
    w.set('overcast');
    sky.setWeather(w.look);
    sky.update(0);
    assert.ok(sky.glow < 0.2);
    assert.ok(clear > sky.horizonColor.r / sky.horizonColor.b, 'the clear sunset is no warmer than the overcast one');
  }
  assert.ok(found);
  sky.dispose();
});

test('the calm end of the sea is the swell it was, and a rough sea stands about 2 m high', () => {
  setSea(0);
  for (let i = 0; i < 200; i++) {
    const x = i * 37.3 - 3000;
    const z = i * -11.9 + 500;
    const t = i * 1.7;
    let h = 0;
    for (const w of SWELL_WAVES) {
      const k = (Math.PI * 2) / w.wavelength;
      h += w.amplitude * Math.sin(k * (x * Math.cos(w.heading) + z * Math.sin(w.heading)) - k * w.speed * t);
    }
    assert.ok(Math.abs(swellAt(x, z, t).height - h) < 1e-12);
  }
  setSea(1, 0.7);
  let top = 0;
  for (let x = 0; x < 1000; x += 4) for (let z = 0; z < 1000; z += 4) top = Math.max(top, swellAt(x, z, 50).height);
  assert.ok(top >= 1.5 && top <= SEA_MAX, `top ${top.toFixed(2)} m`);
  setSea(0);
});

test('the water\'s packed waves agree with the swell the riders sample, far from the start', () => {
  setSea(0.8, 2.1);
  const packed = new Float32Array(SEA_WAVES * 4);
  const origin = { x: 183_456.25, z: -92_311.5 };
  const t = 7_345.3;
  packWaves(origin.x, origin.z, t, packed);
  for (const [rx, rz] of [[0, 0], [12.5, -40], [-300, 220]] as const) {
    let h = 0;
    for (let i = 0; i < SEA_WAVES; i++) h += (packed[i * 4 + 2] ?? 0) * Math.sin(rx * (packed[i * 4] ?? 0) + rz * (packed[i * 4 + 1] ?? 0) + (packed[i * 4 + 3] ?? 0));
    assert.ok(Math.abs(h - swellAt(origin.x + rx, origin.z + rz, t).height) < 2e-3, `render (${String(rx)}, ${String(rz)})`);
  }
  for (let i = 0; i < SEA_WAVES; i++) assert.ok((packed[i * 4 + 3] ?? 0) >= 0 && (packed[i * 4 + 3] ?? 0) < Math.PI * 2);
  setSea(0);
});

test('the water plane is fine at the eye and reaches the far fog', () => {
  const geometry = seaGeometry(64, 120, 10000);
  const p = geometry.getAttribute('position');
  let far = 0;
  let firstRing = Infinity;
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i), p.getY(i));
    far = Math.max(far, r);
    if (r > 0) firstRing = Math.min(firstRing, r);
  }
  assert.ok(Math.abs(far - 10000) < 1);
  assert.ok(firstRing < 0.2);
  geometry.dispose();
});

test('sound follows the weather: rain heard only when it rains, wind and sea rise', () => {
  assert.equal(rainGain(0), 0);
  assert.ok(rainGain(WEATHER.rain.rain) > 0.4);
  assert.ok(weatherWindGain(1) > weatherWindGain(WEATHER.clear.wind));
  assert.ok(seaGain(1) > seaGain(0));
  assert.ok(FX_COUNTS.low.rain < FX_COUNTS.high.rain && FX_COUNTS.low.spray < FX_COUNTS.high.spray);
});

test('rain never rises and never jumps when the wind changes, hours in', () => {
  const w = createWeather(42);
  const box = [RAIN_BOX.x, RAIN_BOX.y, RAIN_BOX.z];
  const offset = [0, 0, 0];
  const step = 0.1;
  let calmest = 1;
  let windiest = 0;
  for (let t = 0; t < 4 * 3600; t += step) {
    const look = w.update(step, t, item(REGION, 0));
    const velocity = rainVelocity(look.wind, t * 0.001);
    assert.ok(velocity[1] < 0, `rain rises at ${String(t)}`);
    const before = [...offset];
    stepRain(offset, velocity, step);
    for (let i = 0; i < 3; i++) {
      // The move this frame, wrapped back out of the box: exactly the velocity over the frame, whatever the clock.
      let moved = (offset[i] ?? 0) - (before[i] ?? 0);
      moved -= Math.round(moved / (box[i] ?? 0)) * (box[i] ?? 0);
      assert.ok(Math.abs(moved - (velocity[i] ?? 0) * step) < 1e-6, `rain jumps at ${String(t)} on axis ${String(i)}`);
      assert.ok((offset[i] ?? 0) >= 0 && (offset[i] ?? 0) < (box[i] ?? 0));
    }
    calmest = Math.min(calmest, look.wind);
    windiest = Math.max(windiest, look.wind);
  }
  assert.ok(windiest - calmest > 0.3, 'the wind changes over the run');
});
