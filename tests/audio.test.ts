import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname, basename } from 'node:path';
import {
  GULL_CALLS,
  GULL_RANGE,
  MUFFLE_CLOSED,
  MUFFLE_OPEN,
  SPLASH_HITS,
  WHALE_BREACH_EXIT,
  WHALE_BREACH_SPLASH,
  WHALE_DIVE,
  WHALE_SPOUT,
  WHALE_SURFACE,
  engineGain,
  gullGain,
  muffle,
  nearestShips,
  surfGain,
  washGain,
  whaleEvents,
  windGain,
  type WhaleMoment,
} from '../src/audio-mix.js';
import { BREACH_EXIT, BREACH_SPLASH, PHASE_LEN, PHASE_ORDER } from '../src/whale-motion.js';
import { CSP, CSP_HEADER } from '../tools/serve.js';
import { item } from '../src/item.js';

const root = resolve(import.meta.dirname, '..');
const audioDir = resolve(root, 'assets/audio');

/** Steps a whale through `phases` at `dt` seconds and collects every event with its phase time. */
function run(phases: WhaleMoment['phase'][], dt = 1 / 60): [number, string, number][] {
  const fired: [number, string, number][] = [];
  let prev: WhaleMoment = { phase: item(phases, 0), phaseT: 0 };
  for (const phase of phases) {
    const steps = Math.ceil(PHASE_LEN[phase] / dt);
    for (let i = 0; i <= steps; i++) {
      const cur: WhaleMoment = { phase, phaseT: Math.min(1, (i * dt) / PHASE_LEN[phase]) };
      const events = whaleEvents(prev, cur);
      if (events) fired.push([events, phase, cur.phaseT]);
      prev = cur;
    }
  }
  return fired;
}

test('whale events fire once at each transition over a full cycle', () => {
  const fired = run(PHASE_ORDER);
  const count = (flag: number) => fired.filter(([e]) => e & flag).length;
  const phases = (name: string) => PHASE_ORDER.filter((p) => p === name).length;
  assert.equal(count(WHALE_SPOUT), phases('spout'));
  assert.equal(count(WHALE_SURFACE), phases('surface'));
  // The first phase in the list is already current, so its own entry never fires.
  assert.equal(count(WHALE_DIVE), phases('dive'));
  assert.equal(count(WHALE_BREACH_EXIT), 1);
  assert.equal(count(WHALE_BREACH_SPLASH), 1);
  const exit = fired.find(([e]) => e & WHALE_BREACH_EXIT);
  const splash = fired.find(([e]) => e & WHALE_BREACH_SPLASH);
  assert.ok(exit && splash);
  assert.ok(exit[2] >= BREACH_EXIT && exit[2] < BREACH_EXIT + 0.01);
  assert.ok(splash[2] >= BREACH_SPLASH && splash[2] < BREACH_SPLASH + 0.01);
  assert.ok(BREACH_EXIT < BREACH_SPLASH);
});

test('whale events stay quiet on steady state', () => {
  const still: WhaleMoment = { phase: 'swim', phaseT: 0.4 };
  assert.equal(whaleEvents(still, still), 0);
  const spout: WhaleMoment = { phase: 'spout', phaseT: 0.3 };
  assert.equal(whaleEvents(spout, { phase: 'spout', phaseT: 0.31 }), 0);
  const breach: WhaleMoment = { phase: 'breach', phaseT: 0.5 };
  assert.equal(whaleEvents(breach, breach), 0);
  // Large frame steps still fire, once.
  assert.equal(whaleEvents({ phase: 'breach', phaseT: 0 }, { phase: 'breach', phaseT: 0.99 }), WHALE_BREACH_EXIT | WHALE_BREACH_SPLASH);
});

test('whale events handle forced phases', () => {
  // Forced into the middle of a breach: the skipped exit does not replay, the coming splash still fires.
  const forced = whaleEvents({ phase: 'swim', phaseT: 0.7 }, { phase: 'breach', phaseT: 0.26 });
  assert.equal(forced & (WHALE_BREACH_EXIT | WHALE_BREACH_SPLASH), 0);
  assert.equal(whaleEvents({ phase: 'breach', phaseT: 0.26 }, { phase: 'breach', phaseT: BREACH_SPLASH + 0.001 }), WHALE_BREACH_SPLASH);
  // Forced from the start: the exit fires as the whale reaches it.
  assert.equal(whaleEvents({ phase: 'swim', phaseT: 0.2 }, { phase: 'breach', phaseT: 0 }), 0);
  assert.equal(whaleEvents({ phase: 'breach', phaseT: 0 }, { phase: 'breach', phaseT: BREACH_EXIT }), WHALE_BREACH_EXIT);
  // Re-forcing the same phase (time jumps back) re-arms without double firing.
  assert.equal(whaleEvents({ phase: 'breach', phaseT: 0.9 }, { phase: 'breach', phaseT: 0.1 }), 0);
  // A forced spout mid-phase still blows.
  assert.equal(whaleEvents({ phase: 'swim', phaseT: 0.1 }, { phase: 'spout', phaseT: 0.5 }), WHALE_SPOUT);
});

test('surf falls with clearance and fades out far from shore', () => {
  let last = Infinity;
  for (let d = 0; d <= 800; d += 10) {
    const g = surfGain(d);
    assert.ok(g >= 0 && g <= 1);
    assert.ok(g <= last + 1e-12, `surf rises at ${String(d)} m`);
    last = g;
  }
  assert.ok(surfGain(0) > 0.9);
  assert.equal(surfGain(700), 0);
  assert.equal(surfGain(-5), surfGain(0));
});

test('gulls are silent far from land', () => {
  assert.equal(gullGain(GULL_RANGE), 0);
  assert.equal(gullGain(GULL_RANGE * 3), 0);
  assert.equal(gullGain(0), 1);
  assert.ok(gullGain(GULL_RANGE * 0.5) > 0 && gullGain(GULL_RANGE * 0.5) < 1);
});

test('wind grows with height, ships fade with distance', () => {
  assert.ok(windGain(40) > windGain(3));
  assert.ok(windGain(0) > 0);
  assert.ok(engineGain(10) > engineGain(100));
  assert.equal(engineGain(1000), 0);
  assert.ok(washGain(5) > washGain(60));
  assert.equal(washGain(300), 0);
});

test('muffle crossfade has the right endpoints and is monotonic in submersion', () => {
  const dry = muffle(0);
  const wet = muffle(1);
  assert.equal(dry.cutoff, MUFFLE_OPEN);
  assert.ok(Math.abs(wet.cutoff - MUFFLE_CLOSED) < 1e-6);
  assert.equal(dry.above, 1);
  assert.equal(dry.below, 0);
  assert.ok(Math.abs(wet.below - 1) < 1e-12);
  assert.ok(wet.above < 0.5);
  const out = muffle(0);
  let prev = { ...dry };
  for (let s = 0.02; s <= 1.0001; s += 0.02) {
    muffle(s, out);
    assert.ok(out.cutoff < prev.cutoff);
    assert.ok(out.above <= prev.above);
    assert.ok(out.below >= prev.below);
    prev = { ...out };
  }
  assert.deepEqual(muffle(-1), dry);
  assert.deepEqual(muffle(2), wet);
});

test('nearest ship selection is stable', () => {
  const ships = [
    { id: 7, x: 100, z: 0 },
    { id: 3, x: 0, z: 100 },
    { id: 9, x: 50, z: 0 },
    { id: 1, x: 0, z: 30 },
    { id: 4, x: 900, z: 0 },
  ];
  const out: number[] = [];
  const dist: number[] = [];
  const n = nearestShips(ships, 0, 0, 3, 650, out, dist);
  assert.equal(n, 3);
  assert.deepEqual(out.slice(0, n).map((i) => item(ships, i).id), [1, 9, 3]);
  assert.deepEqual(dist.slice(0, n), [30, 50, 100]);
  // Equal distances resolve by id, whatever the input order.
  const tied = [
    { id: 5, x: 40, z: 0 },
    { id: 2, x: -40, z: 0 },
    { id: 8, x: 0, z: 40 },
  ];
  const a = nearestShips(tied, 0, 0, 2, 650, out, dist);
  const first = out.slice(0, a).map((i) => item(tied, i).id);
  const b = nearestShips([...tied].reverse(), 0, 0, 2, 650, out, dist);
  const second = out.slice(0, b).map((i) => item([...tied].reverse(), i).id);
  assert.deepEqual(first, [2, 5]);
  assert.deepEqual(second, first);
  // Range limit.
  assert.equal(nearestShips(ships, 0, 0, 3, 20, out, dist), 0);
});

test('sprite offsets fit the packed audio files', () => {
  for (const [start, length] of [...GULL_CALLS, ...SPLASH_HITS]) {
    assert.ok(start >= 0 && length > 0);
  }
  for (let i = 1; i < GULL_CALLS.length; i++) assert.ok(item(GULL_CALLS, i)[0] >= item(GULL_CALLS, i - 1)[0] + item(GULL_CALLS, i - 1)[1]);
  assert.ok(item(SPLASH_HITS, 1)[0] >= item(SPLASH_HITS, 0)[0] + item(SPLASH_HITS, 0)[1]);
});

test('every audio file has both formats, a listed open licence and a source address', async () => {
  const sources = await readFile(resolve(audioDir, 'SOURCES.md'), 'utf8');
  const rows = sources.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Output') && !line.startsWith('|---'));
  const files = (await readdir(audioDir)).filter((name) => name !== 'SOURCES.md');
  assert.ok(files.length > 0);
  const stems = new Set<string>();
  for (const name of files) {
    const ext = extname(name);
    assert.ok(ext === '.ogg' || ext === '.m4a', `unexpected file ${name}`);
    stems.add(basename(name, ext));
    const listed = rows.filter((row) => item(row.split('|'), 1).split(',').map((s) => s.trim()).includes(name));
    assert.ok(listed.length > 0, `${name} is not listed in SOURCES.md`);
    for (const row of listed) {
      const licence = item(row.split('|'), 4).trim();
      assert.match(licence, /^(CC0 1\.0|Public domain|CC BY [0-9.]+)$/, `${name}: licence "${licence}" is not allowed`);
      assert.match(item(row.split('|'), 2), /https:\/\/\S+/, `${name}: no source address`);
      assert.ok(item(row.split('|'), 3).trim().length > 0, `${name}: no author`);
    }
  }
  for (const stem of stems) {
    assert.ok(files.includes(`${stem}.ogg`) && files.includes(`${stem}.m4a`), `${stem} needs .ogg and .m4a`);
  }
});

test('every audio file the code loads exists', async () => {
  const source = await readFile(resolve(root, 'src/audio.ts'), 'utf8');
  const referenced = [...source.matchAll(/new URL\('\.\.\/assets\/audio\/([^']+)'/g)].map((m) => item(m, 1));
  const files = await readdir(audioDir);
  assert.ok(referenced.length > 0);
  for (const name of referenced) assert.ok(files.includes(name), `missing ${name}`);
  for (const name of files.filter((f) => f !== 'SOURCES.md')) assert.ok(referenced.includes(name), `unused ${name}`);
});

test('CSP allows same-origin audio fetches and nothing wider', async () => {
  // Sounds are fetched and decoded with Web Audio, which needs connect-src for the site itself.
  const connect = CSP.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src'));
  assert.equal(connect, "connect-src 'self'");
  assert.ok(!/default-src [^;]*(\*|https?:)/.test(CSP));
  assert.ok(!CSP.includes('media-src'), 'media falls back to default-src self');
  const headers = await readFile(resolve(root, 'public/_headers'), 'utf8');
  assert.ok(headers.includes(`Content-Security-Policy: ${CSP_HEADER}`));
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  assert.ok(html.includes(`content="${CSP}"`));
});
