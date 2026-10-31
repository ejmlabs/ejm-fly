import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { layoutWorld } from '../src/terrain.js';
import { createSeafloor } from '../src/seafloor.js';
import { createWhaleMover } from '../src/whale-behavior.js';
import { PLAN_REACH } from '../src/whale-course.js';
import { item } from '../src/item.js';

/**
 * Top-down map of a seed's world: land from the land mask, the sea tinted by region, the migration lane's
 * centreline dotted and, optionally, the whale's track over some minutes (red) from the start (white ring).
 *
 * usage: npx tsx tools/world-map.ts <seed> <out.png> [extent km] [pixels] [track minutes]    (defaults: 800 720 0)
 */
const seed = Number(process.argv[2] ?? 42);
const out = process.argv[3] ?? `map-${String(seed)}.png`;
const extent = Number(process.argv[4] ?? 800) * 1000;
const size = Number(process.argv[5] ?? 720);
const minutes = Number(process.argv[6] ?? 0);

const SEA: [number, number, number][] = [
  [44, 96, 128],
  [46, 132, 150],
  [92, 120, 140],
  [22, 58, 104],
];
const LAND: [number, number, number] = [116, 140, 84];
const HIGH: [number, number, number] = [160, 150, 120];
const SHALLOW: [number, number, number] = [120, 180, 190];

const layout = layoutWorld(seed);
const land = layout.land;
const png = new PNG({ width: size, height: size, colorType: 2 });
const cell = extent / size;
// The map is centred a quarter of the extent along the migration, so most of it lies ahead.
const ahead = { x: -Math.cos(layout.journey) * extent * 0.25, z: Math.sin(layout.journey) * extent * 0.25 };
const toWorld = (px: number, py: number) => ({ x: ahead.x + (px + 0.5 - size / 2) * cell, z: ahead.z + (py + 0.5 - size / 2) * cell });
const toPixel = (x: number, z: number) => ({ px: Math.round((x - ahead.x) / cell + size / 2 - 0.5), py: Math.round((z - ahead.z) / cell + size / 2 - 0.5) });

function put(px: number, py: number, c: readonly [number, number, number]): void {
  if (px < 0 || py < 0 || px >= size || py >= size) return;
  const k = (py * size + px) * 4;
  png.data[k] = c[0];
  png.data[k + 1] = c[1];
  png.data[k + 2] = c[2];
  png.data[k + 3] = 255;
}

for (let py = 0; py < size; py++) {
  for (let px = 0; px < size; px++) {
    const { x, z } = toWorld(px, py);
    const m = land.maskAt(x, z);
    if (m > 0) {
      // Shaded by the smooth planet layout, so the map shows the continents' bulk rather than the coast noise.
      const t = Math.min(1, Math.max(0, land.planet.macroAt(x, z)));
      put(px, py, [LAND[0] + (HIGH[0] - LAND[0]) * t, LAND[1] + (HIGH[1] - LAND[1]) * t, LAND[2] + (HIGH[2] - LAND[2]) * t]);
    } else {
      const w = land.regions.weightsAt(x, z);
      const sea = [0, 1, 2].map((c) => w.reduce((sum, wk, k) => sum + wk * (item(SEA, k)[c] ?? 0), 0)) as [number, number, number];
      const shallow = Math.max(0, 1 + m / 0.6);
      put(px, py, [sea[0] + (SHALLOW[0] - sea[0]) * shallow, sea[1] + (SHALLOW[1] - sea[1]) * shallow, sea[2] + (SHALLOW[2] - sea[2]) * shallow]);
    }
  }
}

// The lane's centreline, dotted.
for (let s = -extent; s <= extent; s += cell * 2) {
  const c = land.planet.laneCentre(s);
  const p = toPixel(c.x, c.z);
  if (Math.round(s / cell / 2) % 3 === 0) put(p.px, p.py, [235, 235, 235]);
}

if (minutes > 0) {
  const mover = createWhaleMover(seed, layout.whaleHome, layout.viewYaw - Math.PI / 2, createSeafloor(seed, land).heightAt, layout.journey);
  const m = mover.motion;
  land.nav.prefetch(m.x, m.z, 1100, Infinity);
  const dt = 1 / 30;
  for (let i = 1; i <= (minutes * 60) / dt; i++) {
    mover.step(dt, i * dt, land);
    if (i % 15 === 0) land.nav.prefetch(m.x, m.z, PLAN_REACH + 700, 4);
    if (i % 30 === 0) {
      const p = toPixel(m.x, m.z);
      put(p.px, p.py, [220, 40, 40]);
      put(p.px + 1, p.py, [220, 40, 40]);
    }
  }
}

const home = toPixel(layout.whaleHome.x, layout.whaleHome.z);
for (let a = 0; a < 64; a++) put(home.px + Math.round(Math.cos((a / 64) * Math.PI * 2) * 6), home.py + Math.round(Math.sin((a / 64) * Math.PI * 2) * 6), [255, 255, 255]);

writeFileSync(out, PNG.sync.write(png));
console.log(`seed ${String(seed)}: ${(extent / 1000).toFixed(0)} km map, ${(cell).toFixed(0)} m a pixel → ${out}`);
