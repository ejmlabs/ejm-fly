import { PNG } from 'pngjs';
import type { Page } from 'playwright-core';
import { withBrowser, openCalm, DESKTOP } from './browser.js';
import { DAY, HAZE_ANGLES, pickTimeOfDay, presets } from '../src/sky.js';
import { item } from '../src/item.js';

/**
 * Measures each time of day's `haze` colours in `src/sky.ts`: the sky's display colour (sRGB) at each of HAZE_ANGLES
 * above the sea horizon, straight away from the sun, which is how the land's haze matches the sky behind it. Run it
 * after a build, and again whenever a sky preset changes, then paste the printed arrays into the presets.
 *
 * The page opens in the plain frame (`frame=plain`): the land's haze is a display colour that has to match the plainly tone mapped
 * sky, and the finish's grade later lifts land and sky alike. Reduced motion stills the day and the clouds, so each
 * preset is exactly itself. The water, land, ships and whale are hidden, and each angle is read at several nearby
 * azimuths, taking the median per channel, so a cloud, a star or a bird in one sample cannot move the colour.
 *
 * Seed 14221 gives the nearest to a sun with no jitter (under 0.01 degrees of elevation, 0.1 of azimuth), so the
 * values are the presets' own; any other seed measures the sky its sun gives.
 *
 * usage: npx tsx tools/haze-measure.ts [seed]    (run `npm run build` first)
 */

interface CalmReview {
  setDay: (day: number) => void;
  setWeather: (state: 'clear') => void;
  setWaterVisible: (visible: boolean) => void;
  setLandVisible: (visible: boolean) => void;
  setShipsVisible: (visible: boolean) => void;
  setWhaleVisible: (visible: boolean) => void;
  view: (from: Vec3, to: Vec3) => void;
  stats: () => { whale: Vec3; sun: Vec3; sunElevation: number; fov: number };
}

type Vec3 = [number, number, number];

const seed = Number(process.argv[2] ?? 14221);
if (!Number.isInteger(seed) || seed < 0) {
  console.error('usage: npx tsx tools/haze-measure.ts [seed]');
  process.exit(1);
}

const DEGREES = Math.PI / 180;
/** The eye's height; the sky does not depend on it, the land's haze is measured from here (`EYE` in landmesh.ts). */
const EYE = 4;
/** The view looks this far above the horizon, which puts every angle between the mark at the top and the controls below. */
const PITCH = 8;
/** Azimuths sampled either side of straight away from the sun, in degrees. */
const OFFSETS = [-6, -3, 0, 3, 6];
/** The frame is read once two in a row agree: the screenshot can trail the last frame drawn. */
const ATTEMPTS = 8;
/** A preset's haze this far (sRGB levels) from the sky reads as a mismatch. */
const TOLERANCE = 8;

const call = (page: Page, hook: keyof Omit<CalmReview, 'stats'>, ...args: unknown[]) =>
  page.evaluate(`window.__calmReview.${hook}(...${JSON.stringify(args)})`);
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __calmReview: CalmReview }).__calmReview.stats());
const frames = (page: Page, count: number) =>
  page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((done) => requestAnimationFrame(done));
  }, count);

interface Camera { forward: Vec3; right: Vec3; up: Vec3; tanHalfFov: number; aspect: number; width: number; height: number }

/** The camera looking `PITCH` degrees up along the horizontal heading (hx, hz). */
function cameraFor(hx: number, hz: number, fov: number, { width, height }: { width: number; height: number }): Camera {
  const [cos, sin] = [Math.cos(PITCH * DEGREES), Math.sin(PITCH * DEGREES)];
  return {
    forward: [cos * hx, sin, cos * hz],
    right: [-hz, 0, hx],
    up: [-hx * sin, cos, -hz * sin],
    tanHalfFov: Math.tan((fov * DEGREES) / 2),
    aspect: width / height,
    width,
    height,
  };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The pixel that shows the direction `elevation` degrees above the horizon, `turn` degrees round from the heading. */
function pixelOf(camera: Camera, hx: number, hz: number, elevation: number, turn: number): [number, number] {
  const [cosTurn, sinTurn] = [Math.cos(turn * DEGREES), Math.sin(turn * DEGREES)];
  const flat = Math.cos(elevation * DEGREES);
  const direction: Vec3 = [flat * (hx * cosTurn - hz * sinTurn), Math.sin(elevation * DEGREES), flat * (hx * sinTurn + hz * cosTurn)];
  const depth = dot(direction, camera.forward);
  const x = dot(direction, camera.right) / (depth * camera.tanHalfFov * camera.aspect);
  const y = dot(direction, camera.up) / (depth * camera.tanHalfFov);
  return [Math.floor((x * 0.5 + 0.5) * camera.width), Math.floor((0.5 - y * 0.5) * camera.height)];
}

const median = (values: number[]) => item(values.toSorted((a, b) => a - b), values.length >> 1);

interface Reading { colours: number[]; spread: number }

/** The sky's sRGB colour at each of HAZE_ANGLES in the frame on screen, and how far apart the samples of the worst angle were. */
async function read(page: Page, camera: Camera, hx: number, hz: number): Promise<Reading> {
  const frame = PNG.sync.read(await page.screenshot({ scale: 'css', timeout: 120_000 }));
  let spread = 0;
  const colours = HAZE_ANGLES.map((elevation) => {
    const samples = OFFSETS.map((turn) => {
      const [x, y] = pixelOf(camera, hx, hz, elevation, turn);
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw new Error(`${String(elevation)} degrees at ${String(turn)} is off the screen`);
      const at = (y * frame.width + x) * 4;
      return [0, 1, 2].map((channel) => frame.data[at + channel] ?? 0);
    });
    const planes = [0, 1, 2].map((channel) => samples.map((rgb) => rgb[channel] ?? 0));
    spread = Math.max(spread, ...planes.map((values) => Math.max(...values) - Math.min(...values)));
    const [r = 0, g = 0, b = 0] = planes.map(median);
    return (r << 16) | (g << 8) | b;
  });
  return { colours, spread };
}

/** Reads until two frames in a row give the same colours. */
async function measure(page: Page, camera: Camera, hx: number, hz: number): Promise<Reading> {
  let previous: Reading | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    await frames(page, 3);
    const reading = await read(page, camera, hx, hz);
    if (reading.colours.join() === previous?.colours.join()) return reading;
    previous = reading;
  }
  throw new Error('The sky never settled to one frame');
}

const hex = (colour: number) => `0x${colour.toString(16).padStart(6, '0')}`;
const channels = (colour: number) => [colour >> 16, (colour >> 8) & 255, colour & 255];
const levels = (a: number, b: number) => Math.max(...channels(a).map((value, k) => Math.abs(value - (channels(b)[k] ?? 0))));

const start = DAY.indexOf(pickTimeOfDay(seed));
/** Fraction of a day, from the seed's own start, at which the day sits exactly on the preset. */
const dayFor = (index: number) => ((index - start + DAY.length) % DAY.length) / DAY.length;

const problems: string[] = [];
await withBrowser(async (browser, base) => {
  // The plain frame: the haze must match the sky as the tone curve alone draws it, without the finish's grade.
  const { page, context, errors } = await openCalm(browser, base, DESKTOP, { seed, reducedMotion: 'reduce', query: { debug: '1', frame: 'plain' } });
  try {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('The page has no viewport');
    await call(page, 'setWeather', 'clear');
    for (const hook of ['setWaterVisible', 'setLandVisible', 'setShipsVisible', 'setWhaleVisible'] as const) await call(page, hook, false);
    for (const [index, name] of DAY.entries()) {
      await call(page, 'setDay', dayFor(index));
      await frames(page, 2);
      const { whale, sun, sunElevation, fov } = await stats(page);
      // Straight away from the sun, along the horizon.
      const away = Math.hypot(sun[0], sun[2]);
      const [hx, hz] = [-sun[0] / away, -sun[2] / away];
      const camera = cameraFor(hx, hz, fov, viewport);
      const from: Vec3 = [whale[0], EYE, whale[2]];
      await call(page, 'view', from, [from[0] + camera.forward[0] * 1000, from[1] + camera.forward[1] * 1000, from[2] + camera.forward[2] * 1000]);
      const { colours, spread } = await measure(page, camera, hx, hz);
      const current = item(presets, name).haze;
      const worst = Math.max(...colours.map((colour, k) => levels(colour, item(current, k))));
      console.log(`${name} (sun ${sunElevation.toFixed(1)} degrees up, samples within ${String(spread)} levels of each other)`);
      console.log(`  measured: [${colours.map(hex).join(', ')}]`);
      console.log(`  current:  [${current.map(hex).join(', ')}]`);
      console.log(`  largest difference ${String(worst)} levels${worst > TOLERANCE ? ' (the preset no longer matches its sky)' : ''}`);
    }
  } finally {
    await context.close();
  }
  if (errors.length) problems.push(errors.join(' | '));
});
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
