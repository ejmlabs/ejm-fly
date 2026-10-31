import { resolve } from 'node:path';
import { startServer } from './serve.js';
import { DESKTOP, MOBILE, launchBrowser, type DeviceProfile } from './browser.js';
import { item } from '../src/item.js';

/**
 * Load time on a normal connection: cold loads of a built site through a throttled network (9 Mbps down,
 * 1.5 Mbps up, 170 ms round trip) from a server that gzips text as production hosts do, timing first paint, first
 * contentful paint and the first frame of the sea (the page's `calm-first-frame` mark) by the browser's own clocks. With two builds, loads alternate between them and the second is
 * compared to the first; the run fails if any median grows by a second or more. Bytes are reported, never capped.
 *
 * usage: npx tsx tools/load-time.ts [build directory] [build directory to compare] [runs]    (defaults: dist, none, 5)
 */

const NETWORK = { offline: false, latency: 170, downloadThroughput: (9e6 / 8) | 0, uploadThroughput: (1.5e6 / 8) | 0 };
/** Phones also get a slower CPU, as in the usual mobile lab profile. */
const CPU_SLOWDOWN: Record<string, number> = { desktop: 1, mobile: 4 };
/** A change that adds this much to any median fails the comparison. */
const LIMIT_MS = 1000;

interface Sample { firstPaint: number; firstContentfulPaint: number; ready: number; kilobytes: number }
type Row = Record<keyof Sample, number>;

const builds = [process.argv[2] ?? 'dist', process.argv[3]].filter((b): b is string => Boolean(b)).map((b) => resolve(b));
const runs = Number(process.argv[4] ?? 5);

async function sample(url: string, device: DeviceProfile): Promise<Sample> {
  // A fresh browser per load, as on a first visit: an empty cache, and no GPU process still busy with a closed page.
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext(device.context);
    // Builds from before the page marked its first frame: the same mark, at the end of the first frame after ready.
    await context.addInitScript(() => {
      const request = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) =>
        request((time) => {
          callback(time);
          // A frame can come before the body exists.
          if ((document.body as HTMLElement | null)?.dataset['ready'] === 'true' && !performance.getEntriesByName('calm-first-frame').length) performance.mark('calm-first-frame');
        });
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', NETWORK);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN[device.name] ?? 1 });
    let bytes = 0;
    cdp.on('Network.loadingFinished', (event: { encodedDataLength: number }) => {
      bytes += event.encodedDataLength;
    });
    await page.goto(`${url}?seed=42`, { waitUntil: 'commit' });
    // Paint entries are reported asynchronously and can land after the first frame.
    const entries = ['first-paint', 'first-contentful-paint', 'calm-first-frame'];
    await page.waitForFunction((names) => names.every((name) => performance.getEntriesByName(name).length > 0), entries, { timeout: 120000 }).catch(async () => {
      const seen = await page.evaluate((names) => names.filter((name) => performance.getEntriesByName(name).length > 0), entries).catch(() => []);
      throw new Error(`${url} (${device.name}): not every load-time entry within 120 s (seen: ${seen.join(', ') || 'none'})`);
    });
    // No helper functions inside: the page cannot see the names the TypeScript loader adds to them.
    const [firstPaint, firstContentfulPaint, ready] = await page.evaluate(() => [
      performance.getEntriesByName('first-paint')[0]?.startTime,
      performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
      performance.getEntriesByName('calm-first-frame')[0]?.startTime,
    ]);
    if (firstPaint === undefined || firstContentfulPaint === undefined || ready === undefined) throw new Error(`${url} (${device.name}): a paint or first-frame entry is missing`);
    return { firstPaint, firstContentfulPaint, ready, kilobytes: bytes / 1024 };
  } finally {
    await browser.close();
  }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const summarise = (samples: Sample[]): Row => ({
  firstPaint: median(samples.map((s) => s.firstPaint)),
  firstContentfulPaint: median(samples.map((s) => s.firstContentfulPaint)),
  ready: median(samples.map((s) => s.ready)),
  kilobytes: median(samples.map((s) => s.kilobytes)),
});

/** Medians per build and device. Loads alternate between the builds, so a busy machine weighs on each alike. */
async function measure(roots: string[]): Promise<Record<string, Row>[]> {
  const apps = await Promise.all(roots.map((root) => startServer({ port: 0, root })));
  try {
    const out: Record<string, Row>[] = roots.map(() => ({}));
    for (const device of [DESKTOP, MOBILE]) {
      const samples: Sample[][] = roots.map(() => []);
      for (let n = 0; n < runs; n++) for (let b = 0; b < apps.length; b++) item(samples, b).push(await sample(item(apps, b).url, device));
      roots.forEach((root, b) => {
        item(out, b)[device.name] = summarise(item(samples, b));
        console.log(JSON.stringify({ build: root, device: device.name, runs, ...item(out, b)[device.name] }));
      });
    }
    return out;
  } finally {
    await Promise.all(apps.map((app) => app.close()));
  }
}

const results = await measure(builds);
if (results.length === 2) {
  const [base, next] = results as [Record<string, Row>, Record<string, Row>];
  const slower: string[] = [];
  for (const device of Object.keys(base)) {
    for (const metric of ['firstPaint', 'firstContentfulPaint', 'ready'] as const) {
      const added = item(next, device)[metric] - item(base, device)[metric];
      console.log(`${device} ${metric}: ${item(base, device)[metric].toFixed(0)} → ${item(next, device)[metric].toFixed(0)} ms (${added >= 0 ? '+' : ''}${added.toFixed(0)})`);
      if (added >= LIMIT_MS) slower.push(`${device} ${metric} +${added.toFixed(0)} ms`);
    }
  }
  if (slower.length) {
    console.error(`Load time grew by a second or more: ${slower.join(', ')}`);
    process.exitCode = 1;
  }
}
