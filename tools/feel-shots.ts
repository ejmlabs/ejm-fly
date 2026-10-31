import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { withBrowser, openCalm, DESKTOP, MOBILE, type DeviceProfile } from './browser.js';
import { REGION_LOOKS } from '../src/regions.js';
import { layoutWorld } from '../src/terrain.js';
import { DAY } from '../src/sky.js';
import { pickTimeOfDay } from '../src/sky.js';
import { item } from '../src/item.js';

/**
 * Review shots of the journey's feel: every region at two times of day, the three weather states, the night,
 * the route indicator, and the whale cruising with its wake. Uses the ?debug=1 hooks only. Writes JPEGs
 * (CSS pixels) and shots.json to the directory given as the first argument (run `npm run build` first).
 */

type Stats = Record<string, unknown> & {
  speed: number;
  behavior: string;
  region: number;
  regionName: string;
  dayPhase: string;
  weather: string;
  fov: number;
  wakeLength: number;
  wakeDraws: number;
  addedDraws: number;
  stars: number;
  draws: number;
  triangles: number;
  route: string;
  envMs: number;
  envRefreshes: number;
  sunElevation: number;
  cloudCover: number;
  fogDensity: number;
  chunksPending: number;
  whaleHeading: number;
};

interface CalmReview {
  travel: (seconds: number) => void;
  setDay: (day: number) => void;
  setWeather: (state: 'clear' | 'hazy' | 'overcast') => void;
  setRoute: (on: boolean) => void;
  jumpTo: (x: number, z: number) => void;
  stats: () => Stats;
}

const target = process.argv[2];
if (!target) {
  console.error('usage: npx tsx tools/feel-shots.ts <output directory> [seed]');
  process.exit(1);
}
const directory = resolve(target);
await mkdir(directory, { recursive: true });
const seed = Number(process.argv[3] ?? 42);
const start = DAY.indexOf(pickTimeOfDay(seed));

const stats = (page: Page) => page.evaluate(() => (window as unknown as { __calmReview: CalmReview }).__calmReview.stats());
const call = <K extends Exclude<keyof CalmReview, 'stats'>>(page: Page, hook: K, ...args: Parameters<CalmReview[K]>) =>
  page.evaluate(`window.__calmReview.${hook}(...${JSON.stringify(args)})`);

/** Day fraction (of a full day from the seed's own start) that lands on the preset. */
const dayFor = (name: (typeof DAY)[number]) => (((DAY.indexOf(name) - start + DAY.length) % DAY.length) / DAY.length);

/** For each region, the first point along the migration's lane well inside it. */
function regionCentres(): { id: number; x: number; z: number }[] {
  const { land } = layoutWorld(seed);
  const out: { id: number; x: number; z: number }[] = [];
  for (let id = 0; id < 4; id++) {
    for (let s = 0; s < 1_000_000; s += 2000) {
      const { x, z } = land.planet.laneCentre(s);
      if ((land.regions.weightsAt(x, z)[id] ?? 0) > 0.9) {
        out.push({ id, x, z });
        break;
      }
    }
  }
  return out;
}

const log: Record<string, unknown>[] = [];
const problems: string[] = [];
const round = (v: number) => Math.round(v * 100) / 100;

async function cruise(page: Page): Promise<Stats> {
  // Swim on until the whale is travelling at pace and at the surface, then let real frames settle.
  let s = await stats(page);
  for (let i = 0; i < 40 && !(s.behavior === 'travel' && s.speed > 14 && ((s['whale'] as number[])[1] ?? 0) > -1.5); i++) {
    await call(page, 'travel', 4);
    s = await stats(page);
  }
  await page.waitForTimeout(2500);
  return stats(page);
}

async function settle(page: Page, ms = 6000): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __calmReview: CalmReview }).__calmReview.stats().chunksPending === 0, undefined, { timeout: 60000 }).catch(() => {
    // Settling is best effort: the shot is taken either way.
  });
  await page.waitForTimeout(ms);
}

async function shot(page: Page, device: DeviceProfile, label: string): Promise<void> {
  const s = await stats(page);
  await page.screenshot({ path: resolve(directory, `${device.name}-${label}.jpg`), type: 'jpeg', quality: 78, scale: 'css' });
  const entry = {
    shot: `${device.name}-${label}`, region: s.regionName, day: s.dayPhase, weather: s.weather, behavior: s.behavior, speed: round(s.speed),
    fov: round(s.fov), wake: round(s.wakeLength), wakeDraws: s.wakeDraws, added: s.addedDraws, stars: round(s.stars), draws: s.draws, triangles: s.triangles,
    sun: round(s.sunElevation), cloud: round(s.cloudCover), fog: Number(s.fogDensity.toPrecision(3)), route: s.route,
  };
  log.push(entry);
  console.log(JSON.stringify(entry));
}

await withBrowser(async (browser, base) => {
  for (const device of [DESKTOP, MOBILE]) {
    const { page, context, errors } = await openCalm(browser, base, device, { seed, query: { debug: '1', frame: 'finish' } });
    try {
      await page.waitForTimeout(3000);
      // The opening, then the whale cruising near home.
      await shot(page, device, 'opening');
      // The ships of the opening, by dusk and under the stars.
      await call(page, 'setDay', dayFor('dusk'));
      await page.waitForTimeout(2500);
      await shot(page, device, 'opening-dusk');
      await call(page, 'setDay', dayFor('night'));
      await page.waitForTimeout(2500);
      await shot(page, device, 'opening-night');
      await call(page, 'setDay', 0);
      await page.waitForTimeout(1500);
      await cruise(page);
      await shot(page, device, 'cruise-start');

      for (const centre of regionCentres()) {
        const name = item(REGION_LOOKS, centre.id).name.toLowerCase().replace(/\s+/g, '-');
        await call(page, 'jumpTo', centre.x, centre.z);
        await call(page, 'setWeather', 'clear');
        await call(page, 'setDay', dayFor('afternoon'));
        await settle(page, 2000);
        await cruise(page);
        await settle(page, 4000);
        await shot(page, device, `${name}-day`);
        await call(page, 'setDay', dayFor('dusk'));
        await page.waitForTimeout(2500);
        await shot(page, device, `${name}-dusk`);
        if (centre.id === 0) {
          await call(page, 'setDay', dayFor('night'));
          await page.waitForTimeout(2500);
          await shot(page, device, `${name}-night`);
          await call(page, 'setDay', dayFor('morning'));
          await page.waitForTimeout(2500);
          await shot(page, device, `${name}-morning`);
          await call(page, 'setDay', dayFor('afternoon'));
          for (const weather of ['hazy', 'overcast'] as const) {
            await call(page, 'setWeather', weather);
            await page.waitForTimeout(2500);
            await shot(page, device, `${name}-${weather}`);
          }
          await call(page, 'setWeather', 'clear');
        }
      }

      // The indicator, on: it answers the switch, then fades after six seconds.
      await call(page, 'setRoute', true);
      await page.waitForTimeout(2200);
      await shot(page, device, 'indicator-on');
      await page.waitForTimeout(6500);
      const gone = await stats(page);
      if (gone.route !== '') problems.push(`${device.name}: the indicator is still showing after six seconds`);
      await call(page, 'setRoute', false);
      if (errors.length) problems.push(`${device.name}: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  }
});

await writeFile(resolve(directory, 'shots.json'), `${JSON.stringify(log, null, 2)}\n`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
