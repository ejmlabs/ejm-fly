export function parseSeed(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) return null;
  const number = Number(value);
  return Number.isInteger(number) && number <= 0xffffffff ? number : null;
}

export interface SeedResolution { seed: number; explicit: boolean }

export function resolveSeed(search = '', savedSeed?: number | null, entropy: () => number = Math.random): SeedResolution {
  const explicit = parseSeed(new URLSearchParams(search).get('seed'));
  if (explicit !== null) return { seed: explicit, explicit: true };
  if (typeof savedSeed === 'number' && Number.isInteger(savedSeed) && savedSeed >= 0 && savedSeed <= 0xffffffff) {
    return { seed: savedSeed, explicit: false };
  }
  return { seed: Math.floor(entropy() * 0x100000000) >>> 0, explicit: false };
}

export function seedURL(address: string | URL, seed: number): URL {
  const url = new URL(address);
  url.searchParams.set('seed', String(seed >>> 0));
  return url;
}

export function nextSeed(current: number, entropy: () => number = Math.random): number {
  let candidate = Math.floor(entropy() * 0x100000000) >>> 0;
  if (candidate === (current >>> 0)) candidate = (candidate + 1) >>> 0;
  return candidate;
}
