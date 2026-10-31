import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright-core';
import { withBrowser, openCalm, DESKTOP, MOBILE, type DeviceProfile } from './browser.js';

const directory = fileURLToPath(new URL('../shots/', import.meta.url));
const seeds = [42, 7, 1234];
await mkdir(directory, { recursive: true });

interface CalmReview {
  time?: number;
  advance?: (seconds: number) => void;
  forceBreach?: () => void;
  forceSpout?: () => void;
  forceDeepDive?: (at?: number) => void;
  frameWhale?: (kind?: 'breach' | 'spout') => void;
  frame?: (yaw: number, pitch: number, distance: number) => void;
  stats?: () => Record<string, unknown>;
}

async function settle(page: Page, seconds = 3) {
  await page.waitForFunction(
    () => (window as unknown as { __calmReview?: CalmReview }).__calmReview?.stats,
    null,
    { timeout: 20000 },
  ).catch(() => {
    // Settling is best effort: the shot is taken either way.
  });
  await page.waitForTimeout(seconds * 1000);
}

async function capture(
  browser: Browser,
  base: string,
  device: DeviceProfile,
  seed: number,
  path: string,
  query: Record<string, string> = { debug: '1', frame: 'finish' },
  afterOpen?: (page: Page) => Promise<void>,
) {
  const { page, context, errors } = await openCalm(browser, base, device, { seed, query });
  try {
    await settle(page, device.name === 'mobile' ? 2.5 : 3);
    if (afterOpen) await afterOpen(page);
    await page.screenshot({ path, type: 'png' });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(`Saved ${String(path.split('/').pop())}`);
  } finally {
    await context.close();
  }
}

await withBrowser(async (browser, base) => {
  for (const seed of seeds) {
    for (const device of [MOBILE, DESKTOP]) {
      await capture(browser, base, device, seed, `${directory}${device.name}-seed${String(seed)}.png`);
    }
  }

  // Mid-spout / breach moments for review.
  await capture(
    browser,
    base,
    MOBILE,
    42,
    `${directory}mobile-spout.png`,
    { debug: '1', frame: 'finish' },
    async (page) => {
      // Natural phone camera. First spout peaks ~5 s (phase offset); seek there, not a close debug frame.
      await page.evaluate(() => {
        const review = (window as unknown as { __calmReview?: CalmReview }).__calmReview;
        const now = review?.time ?? 0;
        const target = 5.1;
        if (now < target) review?.advance?.(target - now);
      });
      await page.waitForTimeout(500);
    },
  );

  await capture(
    browser,
    base,
    MOBILE,
    42,
    `${directory}mobile-breach.png`,
    { debug: '1', frame: 'finish' },
    async (page) => {
      await page.evaluate(() => {
        (window as unknown as { __calmReview?: CalmReview }).__calmReview?.forceBreach?.();
      });
      await page.waitForTimeout(350);
      await page.evaluate(() => {
        (window as unknown as { __calmReview?: CalmReview }).__calmReview?.frameWhale?.('breach');
      });
      await page.waitForTimeout(300);
    },
  );

  await capture(
    browser,
    base,
    DESKTOP,
    42,
    `${directory}desktop-breach.png`,
    { debug: '1', frame: 'finish' },
    async (page) => {
      await page.evaluate(() => {
        (window as unknown as { __calmReview?: CalmReview }).__calmReview?.forceBreach?.();
      });
      await page.waitForTimeout(350);
      await page.evaluate(() => {
        (window as unknown as { __calmReview?: CalmReview }).__calmReview?.frameWhale?.('breach');
      });
      await page.waitForTimeout(300);
    },
  );

  // Chase camera under water: start a deep dive and let the camera follow it down.
  for (const device of [MOBILE, DESKTOP]) {
    await capture(browser, base, device, 42, `${directory}${device.name}-dive.png`, { debug: '1', frame: 'finish' }, async (page) => {
      await page.evaluate(() => {
        (window as unknown as { __calmReview?: CalmReview }).__calmReview?.forceDeepDive?.(0.35);
      });
      await page.waitForTimeout(5000);
    });
  }

  // Convenience aliases for the seed-42 heroes.
  await capture(browser, base, MOBILE, 42, `${directory}mobile.png`);
  await capture(browser, base, DESKTOP, 42, `${directory}desktop.png`);
});
