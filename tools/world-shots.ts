import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';
import type { Page } from 'playwright-core';
import { withBrowser, openCalm, DESKTOP, MOBILE, type DeviceProfile } from './browser.js';
import { layoutWorld } from '../src/terrain.js';
import { createLand, type Land } from '../src/land.js';
import { DAY, createSky, pickTimeOfDay } from '../src/sky.js';
import { headlessRenderer } from './headless-renderer.js';

/**
 * Review screenshots of the world's layout, desktop and phone: the whale mid-ocean with an open horizon,
 * approaching a continent, and in an archipelago, each found along the seed's migration lane.
 *
 * usage: npx tsx tools/world-shots.ts <output directory> [seed ...]    (default seed 42)
 */
interface CalmReview {
  travel: (seconds: number) => void;
  jumpTo: (x: number, z: number) => void;
  setDay: (fraction: number) => void;
  setWeather: (state: 'clear' | 'hazy' | 'overcast') => void;
  stats: () => Record<string, number | string | boolean | number[]>;
}

const target = process.argv[2];
if (!target) {
  console.error('usage: npx tsx tools/world-shots.ts <output directory> [seed ...]');
  process.exit(1);
}
const directory = resolve(target);
await mkdir(directory, { recursive: true });
const seeds = process.argv.slice(3).map(Number);
if (!seeds.length) seeds.push(42);

const call = <K extends Exclude<keyof CalmReview, 'stats'>>(page: Page, hook: K, ...args: Parameters<CalmReview[K]>) =>
  page.evaluate(`window.__calmReview.${hook}(...${JSON.stringify(args)})`);
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __calmReview: CalmReview }).__calmReview.stats());

/** Share of a disc of `radius` around (x, z) that is land, on a 250 m lattice. */
function landShare(land: Land, x: number, z: number, radius: number): number {
  let hit = 0;
  let n = 0;
  for (let u = -radius; u <= radius; u += 250) {
    for (let v = -radius; v <= radius; v += 250) {
      if (u * u + v * v > radius * radius) continue;
      n++;
      if (land.maskAt(x + u, z + v) > 0) hit++;
    }
  }
  return hit / n;
}

interface Spot { name: string; x: number; z: number }

/** Points along the lane, a few kilometres before each kind of place, so the whale swims toward it. */
function spots(seed: number): Spot[] {
  // The page lays the world out for the seed's own sun; a sky with no renderer gives the same azimuth.
  const renderer = headlessRenderer();
  const layout = layoutWorld(seed, createSky(seed, renderer, new THREE.Scene()).sunAzimuthDeg);
  // Natural land only: the open sea's rocks would count as land everywhere.
  const land = createLand(seed, { viewYaw: layout.viewYaw, offset: layout.land.offset, landmarks: false });
  const planet = land.planet;
  const found: Spot[] = [];
  const want = new Set(['open-ocean', 'continent', 'archipelago']);
  for (let s = 20000; s < 800000 && want.size; s += 1000) {
    const here = planet.laneCentre(s);
    const ahead = planet.laneCentre(s + 5000);
    const before = planet.laneCentre(s - 5000);
    if (want.has('open-ocean') && landShare(land, here.x, here.z, 9000) === 0 && landShare(land, ahead.x, ahead.z, 6000) === 0) {
      found.push({ name: 'open-ocean', ...before });
      want.delete('open-ocean');
    }
    // A continent (not one of the lane's islands) filling most of a disc just off the lane.
    if (want.has('continent') && [-11000, 11000].some((q) => {
      const c = { x: here.x + q * Math.sin(planet.heading), z: here.z + q * Math.cos(planet.heading) };
      return planet.openAt(c.x, c.z) < 0 && landShare(land, c.x, c.z, 4000) > 0.6;
    })) {
      found.push({ name: 'continent', ...planet.laneCentre(s - 6000) });
      want.delete('continent');
    }
    if (want.has('archipelago') && planet.openAt(here.x, here.z) > 8000) {
      const share = landShare(land, here.x, here.z, 3000);
      if (share > 0.06 && share < 0.25) {
        found.push({ name: 'archipelago', ...planet.laneCentre(s - 1500) });
        want.delete('archipelago');
      }
    }
  }
  return found;
}

const log: Record<string, unknown>[] = [];
const problems: string[] = [];

await withBrowser(async (browser, base) => {
  for (const seed of seeds) {
    const places = spots(seed);
    console.log(`seed ${String(seed)}: ${places.map((p) => `${p.name} at ${String(Math.round(p.x))}, ${String(Math.round(p.z))}`).join('; ')}`);
    const start = DAY.indexOf(pickTimeOfDay(seed));
    const afternoon = ((DAY.indexOf('afternoon') - start + DAY.length) % DAY.length) / DAY.length;
    for (const device of [DESKTOP, MOBILE] as DeviceProfile[]) {
      const { page, context, errors } = await openCalm(browser, base, device, { seed, query: { debug: '1', frame: 'finish' } });
      try {
        await page.waitForTimeout(2000);
        for (const place of places) {
          await call(page, 'jumpTo', place.x, place.z);
          await call(page, 'setWeather', 'clear');
          await call(page, 'setDay', afternoon);
          // Swim on a little so the chase view settles behind the whale, at the surface, then let the tiles stream in.
          await call(page, 'travel', 20);
          for (let i = 0; i < 40; i++) {
            const s = await stats(page);
            if (s['behavior'] === 'travel' && ((s['whale'] as number[])[1] ?? 0) > -1.5) break;
            await call(page, 'travel', 4);
          }
          await page.waitForFunction(() => (window as unknown as { __calmReview: CalmReview }).__calmReview.stats()['chunksPending'] === 0, undefined, { timeout: 60000 }).catch(() => {
    // Settling is best effort: the shot is taken either way.
  });
          await page.waitForTimeout(4000);
          const s = await stats(page);
          const file = `world-${device.name}-${String(seed)}-${place.name}.jpg`;
          await page.screenshot({ path: resolve(directory, file), type: 'jpeg', quality: 80, scale: 'css' });
          const entry = { file, seed, place: place.name, region: s['regionName'], landNear: s['landNear'], draws: s['draws'], triangles: s['triangles'] };
          log.push(entry);
          console.log(JSON.stringify(entry));
        }
        if (errors.length) problems.push(`${device.name} seed ${String(seed)}: ${errors.join(' | ')}`);
      } finally {
        await context.close();
      }
    }
  }
});

await writeFile(resolve(directory, 'world-shots.json'), `${JSON.stringify(log, null, 2)}\n`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
