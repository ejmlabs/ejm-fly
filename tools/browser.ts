import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright-core';
import { startServer } from './serve.js';

export interface DeviceProfile {
  name: string;
  context: BrowserContextOptions;
}

export const DESKTOP: DeviceProfile = { name: 'desktop', context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } };
export const MOBILE: DeviceProfile = {
  name: 'mobile',
  context: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  },
};

/** Headless system Chrome with software WebGL. */
export function launchBrowser(): Promise<Browser> {
  const executablePath = process.env['BROWSER_PATH'] ?? '/usr/bin/google-chrome';
  const args = ['--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];
  // Opt in with BROWSER_NO_SANDBOX=1. Default keeps the sandbox on.
  if (process.env['BROWSER_NO_SANDBOX'] === '1') args.unshift('--no-sandbox');
  return chromium.launch({ executablePath, headless: true, args });
}

export async function withBrowser<T>(run: (browser: Browser, url: string) => Promise<T>): Promise<T> {
  const app = await startServer({ port: 0 });
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();
    return await run(browser, app.url);
  } finally {
    await browser?.close();
    await app.close();
  }
}

export interface OpenCalmOptions {
  seed?: number | null;
  reducedMotion?: 'no-preference' | 'reduce';
  storage?: unknown;
  query?: Record<string, string>;
  instrument?: boolean;
}

export interface OpenCalmResult {
  page: Page;
  context: BrowserContext;
  errors: string[];
  external: string[];
}

export async function openCalm(
  browser: Browser,
  base: string,
  device: DeviceProfile,
  { seed = 42, reducedMotion = 'no-preference', storage, query = {}, instrument = false }: OpenCalmOptions = {},
): Promise<OpenCalmResult> {
  const context = await browser.newContext({ ...device.context, reducedMotion });
  if (storage) {
    await context.addInitScript((value) => {
      localStorage.setItem('ejm-calm:v1', JSON.stringify(value));
    }, storage);
  }
  if (instrument) {
    await context.addInitScript(() => {
      type DrawWindow = Window & { __draws: number; __frameDraws: number[] };
      const w = window as unknown as DrawWindow;
      w.__draws = 0;
      w.__frameDraws = [];
      const request = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback: FrameRequestCallback) =>
        request((time) => {
          const before = w.__draws;
          callback(time);
          const draws = w.__draws - before;
          if (draws) {
            w.__frameDraws.push(draws);
            if (w.__frameDraws.length > 120) w.__frameDraws.shift();
          }
        });
      for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'] as const) {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- the original is re-applied with each call's own context below
        const original = WebGL2RenderingContext.prototype[method] as (...args: unknown[]) => unknown;
        (WebGL2RenderingContext.prototype as unknown as Record<string, unknown>)[method] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
          w.__draws++;
          return original.apply(this, args);
        };
      }
    });
  }
  const page = await context.newPage();
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) external.push(request.url());
  });
  const address = new URL('/', base);
  if (seed !== null) address.searchParams.set('seed', String(seed));
  for (const [key, value] of Object.entries(query)) address.searchParams.set(key, value);
  await page.goto(address.href, { waitUntil: 'networkidle' });
  try {
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${errors.join('\n')}\n${String(await page.locator('#veilText').textContent())}`, { cause: error });
  }
  return { page, context, errors, external };
}

/** @deprecated Use openCalm */
export const openFlight = openCalm;
