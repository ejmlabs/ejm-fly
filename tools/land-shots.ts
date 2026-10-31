import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { withBrowser, openCalm, DESKTOP, MOBILE, type DeviceProfile } from './browser.js';
import { DAY, pickTimeOfDay } from '../src/sky.js';

/**
 * Review shots of the land: the opening by day, dusk and night, the highest range in sight by afternoon and dusk, then a close coast from a review camera on the
 * water off the nearest town and the nearest herd. Uses the ?debug=1 hooks only. Writes JPEGs (CSS pixels) and
 * shots.json to the directory given as the first argument (run `npm run build` first).
 *
 * usage: npx tsx tools/land-shots.ts <output directory> [seed]
 */

interface Life { kind: 'town' | 'herd'; x: number; y: number; z: number; count: number; vantage: [number, number, number] | null }
type Stats = Record<string, number | string | number[]>;

const target = process.argv[2];
if (!target) {
  console.error('usage: npx tsx tools/land-shots.ts <output directory> [seed]');
  process.exit(1);
}
const directory = resolve(target);
await mkdir(directory, { recursive: true });
const seed = Number(process.argv[3] ?? 42);
const start = DAY.indexOf(pickTimeOfDay(seed));
const dayFor = (name: (typeof DAY)[number]) => (((DAY.indexOf(name) - start + DAY.length) % DAY.length) / DAY.length);

const stats = (page: Page) => page.evaluate(() => (window as unknown as { __calmReview: { stats: () => Stats } }).__calmReview.stats());
const call = (page: Page, hook: string, ...args: unknown[]) => page.evaluate(`window.__calmReview.${hook}(...${JSON.stringify(args)})`);

const log: Record<string, unknown>[] = [];
const problems: string[] = [];

async function settle(page: Page, ms: number): Promise<void> {
  // Every tile built and none still dissolving in.
  await page.waitForFunction(() => {
    const s = (window as unknown as { __calmReview: { stats: () => Stats } }).__calmReview.stats();
    return s['chunksPending'] === 0 && s['chunksFading'] === 0;
  }, undefined, { timeout: 60000 }).catch(() => {
    // Settling is best effort: the shot is taken either way.
  });
  await page.waitForTimeout(ms);
}

async function shot(page: Page, device: DeviceProfile, label: string): Promise<void> {
  const s = await stats(page);
  await page.screenshot({ path: resolve(directory, `${device.name}-${label}.jpg`), type: 'jpeg', quality: 80, scale: 'css' });
  const entry = {
    shot: `${device.name}-${label}`, day: s['dayPhase'], draws: s['draws'], triangles: s['triangles'], landTriangles: s['landTriangles'],
    landObjects: s['landObjects'], objectTriangles: s['objectTriangles'], walkers: s['walkers'], walkerDraws: s['walkerDraws'], walkerTriangles: s['walkerTriangles'],
  };
  log.push(entry);
  console.log(JSON.stringify(entry));
}

await withBrowser(async (browser, base) => {
  for (const device of [DESKTOP, MOBILE]) {
    const { page, context, errors } = await openCalm(browser, base, device, { seed, query: { debug: '1', frame: 'finish' } });
    try {
      await settle(page, 3000);
      await shot(page, device, 'land-opening');
      for (const day of ['dusk', 'night'] as const) {
        await call(page, 'setDay', dayFor(day));
        await page.waitForTimeout(2500);
        await shot(page, device, `land-opening-${day}`);
      }
      // The highest range 2.5 to 7 km out, from the water where the whale is, a little up.
      const peak = (await call(page, 'peak', 2500, 7000)) as { x: number; y: number; z: number };
      const whale = ((await stats(page))['whale'] as number[]);
      await call(page, 'view', [whale[0], 14, whale[2]], [peak.x, peak.y * 0.6, peak.z]);
      for (const day of ['afternoon', 'dusk'] as const) {
        await call(page, 'setDay', dayFor(day));
        await settle(page, 3500);
        await shot(page, device, `far-range-${day}`);
      }
      await call(page, 'view', null);
      const life = await page.evaluate<Life[]>('window.__calmReview.life(8000)');
      const seen = life.filter((l) => l.vantage);
      const town = seen.find((l) => l.kind === 'town');
      // A herd near the town if there is one, else the nearest.
      const herd = seen.filter((l) => l.kind === 'herd').sort((a, b) => (town ? Math.hypot(a.x - town.x, a.z - town.z) - Math.hypot(b.x - town.x, b.z - town.z) : 0))[0];
      if (!town) problems.push(`${device.name}: no town within 8 km of the start`);
      if (!herd) problems.push(`${device.name}: no herd within 8 km of the start`);
      for (const subject of [town, herd]) {
        if (!subject) continue;
        // On the water off the subject, a little up, looking in at it.
        await call(page, 'view', subject.vantage, [subject.x, subject.y + 3, subject.z]);
        for (const day of subject.kind === 'town' ? (['afternoon', 'dusk', 'night'] as const) : (['afternoon'] as const)) {
          await call(page, 'setDay', dayFor(day));
          await settle(page, 3500);
          await shot(page, device, `close-${subject.kind}-${day}`);
        }
      }
      await call(page, 'view', null);
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
