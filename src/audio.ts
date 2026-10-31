import * as THREE from 'three';
import type { WhaleState } from './whale.js';
import type { Shore } from './shore.js';
import type { FloatingOrigin, ShipEmitter, WaterSignal } from './seams.js';
import { damp, lerp } from './math.js';
import { hash, random, type Rng } from './rng.js';
import { item } from './item.js';
import {
  GULL_CALLS,
  SPLASH_HITS,
  SHIP_RANGE,
  WHALE_BREACH_EXIT,
  WHALE_BREACH_SPLASH,
  WHALE_DIVE,
  WHALE_SPOUT,
  WHALE_SURFACE,
  engineGain,
  gullGain,
  hornGain,
  muffle,
  nearestShips,
  oceanGain,
  rainGain,
  seaGain,
  surfGain,
  washGain,
  whaleEvents,
  weatherWindGain,
  windGain,
  type Muffle,
  type ShipPoint,
  type WhaleMoment,
} from './audio-mix.js';

/**
 * Layered ocean sound from recorded samples (see assets/audio/SOURCES.md). Off by
 * default; nothing is created or fetched until the user turns sound on, and
 * nothing runs while it is off or the page is hidden.
 */

export interface AudioSettings { enabled: boolean; volume: number }

export interface AudioInput {
  /** The listener rides on this camera (render coordinates). */
  camera: THREE.Camera;
  signal: WaterSignal;
  /** World coordinates. */
  whale: WhaleState;
  ships: readonly ShipEmitter[];
  /** World coordinates. */
  shore: Shore;
  origin: FloatingOrigin;
  /** The weather now: rain, wind and sea, each 0 to 1. */
  weather: { rain: number; wind: number; sea: number };
}

const SOUNDS = {
  ocean: [new URL('../assets/audio/ocean.ogg', import.meta.url).href, new URL('../assets/audio/ocean.m4a', import.meta.url).href],
  surf: [new URL('../assets/audio/surf.ogg', import.meta.url).href, new URL('../assets/audio/surf.m4a', import.meta.url).href],
  wind: [new URL('../assets/audio/wind.ogg', import.meta.url).href, new URL('../assets/audio/wind.m4a', import.meta.url).href],
  gulls: [new URL('../assets/audio/gulls.ogg', import.meta.url).href, new URL('../assets/audio/gulls.m4a', import.meta.url).href],
  engine: [new URL('../assets/audio/ship-engine.ogg', import.meta.url).href, new URL('../assets/audio/ship-engine.m4a', import.meta.url).href],
  wash: [new URL('../assets/audio/ship-wash.ogg', import.meta.url).href, new URL('../assets/audio/ship-wash.m4a', import.meta.url).href],
  horn: [new URL('../assets/audio/ship-horn.ogg', import.meta.url).href, new URL('../assets/audio/ship-horn.m4a', import.meta.url).href],
  blow: [new URL('../assets/audio/whale-blow.ogg', import.meta.url).href, new URL('../assets/audio/whale-blow.m4a', import.meta.url).href],
  splash: [new URL('../assets/audio/splash.ogg', import.meta.url).href, new URL('../assets/audio/splash.m4a', import.meta.url).href],
  song: [new URL('../assets/audio/whale-song.ogg', import.meta.url).href, new URL('../assets/audio/whale-song.m4a', import.meta.url).href],
  underwater: [new URL('../assets/audio/underwater.ogg', import.meta.url).href, new URL('../assets/audio/underwater.m4a', import.meta.url).href],
} as const;

type SoundName = keyof typeof SOUNDS;
type Buffers = Record<SoundName, AudioBuffer>;

const MIX_STEP = 1 / 20;
const SHORE_STEP = 0.2;
const SHIP_SLOTS = 3;
const MASTER = 2.2;
const SMOOTH = 0.25;

function preferOpus(): boolean {
  try {
    return document.createElement('audio').canPlayType('audio/ogg; codecs="opus"') !== '';
  } catch {
    return false;
  }
}

async function decode(context: AudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`audio ${String(response.status)}`);
  return context.decodeAudioData(await response.arrayBuffer());
}

async function loadAll(context: AudioContext): Promise<Buffers> {
  const opus = preferOpus();
  const names = Object.keys(SOUNDS) as SoundName[];
  const buffers = await Promise.all(
    names.map(async (name) => {
      const [ogg, m4a] = SOUNDS[name];
      if (!opus) return decode(context, m4a);
      // A browser can claim Opus yet fail to decode Ogg; fall back per file.
      return decode(context, ogg).catch(() => decode(context, m4a));
    }),
  );
  return Object.fromEntries(names.map((name, i) => [name, item(buffers, i)])) as Buffers;
}

function setLevel(param: AudioParam, value: number, now: number, timeConstant = SMOOTH): void {
  param.setTargetAtTime(value, now, timeConstant);
}

type Voice = THREE.Audio | THREE.PositionalAudio;

interface ShipSlot {
  engine: THREE.PositionalAudio;
  wash: THREE.PositionalAudio;
  /** Ship id this slot follows, or -1 while fading out / idle. */
  id: number;
  level: number;
}

/** Everything that exists only once sound has been turned on. */
class SoundEngine {
  readonly listener: THREE.AudioListener;
  readonly context: AudioContext;
  loaded = false;
  failed = false;
  private loading: Promise<void> | null = null;
  private readonly rng: Rng;

  private readonly above: GainNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly aboveOut: GainNode;
  private readonly below: GainNode;

  private voices: Voice[] = [];
  private ocean!: THREE.Audio;
  private wind!: THREE.Audio;
  private rain!: THREE.Audio;
  private surf!: THREE.PositionalAudio;
  private underwater!: THREE.Audio;
  private song!: THREE.Audio;
  private gulls: THREE.PositionalAudio[] = [];
  private splashes: THREE.PositionalAudio[] = [];
  private blow!: THREE.PositionalAudio;
  private horn!: THREE.PositionalAudio;
  private slots: ShipSlot[] = [];

  // Reused state; nothing below is allocated per frame.
  private readonly prev: WhaleMoment = { phase: 'swim', phaseT: 0 };
  private hasPrev = false;
  private readonly mix: Muffle = muffle(0);
  private readonly tmp = new THREE.Vector3();
  private readonly listenerPos = new THREE.Vector3();
  private readonly points: ShipPoint[] = [];
  private readonly nearest: number[] = [];
  private readonly nearestDist: number[] = [];
  private lastTime = 0;
  private mixClock = 0;
  private shoreClock = SHORE_STEP;
  private clearance = Infinity;
  /** Smoothed shore point, render coordinates. */
  private shoreX = 0;
  private shoreZ = 0;
  private shoreTargetX = 0;
  private shoreTargetZ = 0;
  private shoreKnown = false;
  private gullTimer = 2;
  private hornTimer = 0;
  private gustTimer = 0;
  private gust = 1;
  private gustTarget = 1;
  private songTimer = 0;
  private songOn = false;
  private origin: FloatingOrigin | null = null;
  private unsubscribe: (() => void) | null = null;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(seed: number) {
    this.rng = random(hash(seed, 0x534e44));
    // Creating the listener creates the AudioContext; this runs inside the enabling tap.
    this.listener = new THREE.AudioListener();
    this.context = this.listener.context;
    this.listener.gain.gain.value = 0;
    const ctx = this.context;
    this.above = ctx.createGain();
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = this.mix.cutoff;
    this.lowpass.Q.value = 0.5;
    this.aboveOut = ctx.createGain();
    this.below = ctx.createGain();
    this.below.gain.value = 0;
    this.above.connect(this.lowpass);
    this.lowpass.connect(this.aboveOut);
    this.aboveOut.connect(this.listener.getInput());
    this.below.connect(this.listener.getInput());
    // Soft ceiling so a close breach never clips the calm mix.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.25;
    this.listener.setFilter(limiter);
    this.hornTimer = 40 + this.rng() * 50;
    this.songTimer = 8 + this.rng() * 20;
  }

  load(): Promise<void> {
    this.loading ??= loadAll(this.context).then(
      (buffers) => {
        this.build(buffers);
        this.loaded = true;
      },
      () => {
        this.failed = true;
      },
    );
    return this.loading;
  }

  private loop<T extends Voice>(voice: T, buffer: AudioBuffer): T {
    voice.setBuffer(buffer);
    voice.setLoop(true);
    voice.setVolume(0);
    return voice;
  }

  private flat(bus: AudioNode): THREE.Audio {
    const voice = new THREE.Audio(this.listener);
    this.route(voice, bus);
    return voice;
  }

  private positional(bus: AudioNode): THREE.PositionalAudio {
    const voice = new THREE.PositionalAudio(this.listener);
    // Direction only: distance falloff comes from the mixing rules.
    voice.panner.panningModel = 'equalpower';
    voice.setRolloffFactor(0);
    this.route(voice, bus);
    return voice;
  }

  private route(voice: Voice, bus: AudioNode): void {
    voice.gain.disconnect();
    voice.gain.connect(bus);
    this.voices.push(voice);
  }

  private build(b: Buffers): void {
    this.ocean = this.loop(this.flat(this.above), b.ocean);
    this.wind = this.loop(this.flat(this.above), b.wind);
    this.rain = this.loop(this.flat(this.above), this.hiss());
    const hiss = this.context.createBiquadFilter();
    hiss.type = 'highpass';
    hiss.frequency.value = 900;
    this.rain.setFilter(hiss);
    this.surf = this.loop(this.positional(this.above), b.surf);
    this.underwater = this.loop(this.flat(this.below), b.underwater);
    this.song = this.loop(this.flat(this.below), b.song);
    for (let i = 0; i < SHIP_SLOTS; i++) {
      this.slots.push({
        engine: this.loop(this.positional(this.above), b.engine),
        wash: this.loop(this.positional(this.above), b.wash),
        id: -1,
        level: 0,
      });
    }
    for (let i = 0; i < 2; i++) {
      const gull = this.positional(this.above);
      gull.setBuffer(b.gulls);
      this.gulls.push(gull);
      const splash = this.positional(this.above);
      splash.setBuffer(b.splash);
      this.splashes.push(splash);
    }
    this.blow = this.positional(this.above);
    this.blow.setBuffer(b.blow);
    this.horn = this.positional(this.above);
    this.horn.setBuffer(b.horn);
    // Beds start at random points so every visit sounds a little different.
    for (const bed of [this.ocean, this.wind, this.rain, this.surf, this.underwater, this.song]) {
      bed.offset = this.rng() * (bed.buffer?.duration ?? 0);
      bed.play();
      bed.offset = 0;
    }
    this.lastTime = this.context.currentTime;
  }

  /** Rain made here, not fetched: two seconds of noise, a little clumped so it patters. */
  private hiss(): AudioBuffer {
    const rate = this.context.sampleRate;
    const buffer = this.context.createBuffer(1, rate * 2, rate);
    const data = buffer.getChannelData(0);
    let patter = 0;
    for (let i = 0; i < data.length; i++) {
      if (this.rng() < 0.002) patter = 1;
      patter *= 0.995;
      data[i] = (this.rng() * 2 - 1) * (0.55 + 0.45 * patter);
    }
    return buffer;
  }

  async wake(volume: number): Promise<void> {
    if (this.sleepTimer !== null) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    if (this.context.state !== 'running') await this.context.resume();
    await this.load();
    // Whale moments that passed while asleep should not fire on waking.
    this.hasPrev = false;
    // Slow fade in, both on first load and after returning to the page.
    setLevel(this.listener.gain.gain, volume * MASTER, this.context.currentTime, 0.8);
    this.lastTime = this.context.currentTime;
  }

  sleep(): void {
    setLevel(this.listener.gain.gain, 0, this.context.currentTime, 0.12);
    if (this.sleepTimer !== null) return;
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null;
      if (this.context.state === 'running') {
        this.context.suspend().catch(() => {
          // A context that will not suspend stays awake and silent.
        });
      }
    }, 600);
  }

  playing(): number {
    let count = 0;
    for (let i = 0; i < this.voices.length; i++) if (item(this.voices, i).isPlaying) count++;
    return count;
  }

  private follow(origin: FloatingOrigin): void {
    if (this.origin === origin) return;
    this.unsubscribe?.();
    this.origin = origin;
    this.unsubscribe = origin.onRecenter((dx, dz) => {
      this.shoreX -= dx;
      this.shoreZ -= dz;
      this.shoreTargetX -= dx;
      this.shoreTargetZ -= dz;
    });
  }

  update(input: AudioInput): void {
    if (!this.loaded) return;
    const now = this.context.currentTime;
    const dt = Math.min(0.25, Math.max(0, now - this.lastTime));
    this.lastTime = now;
    if (this.listener.parent !== input.camera) input.camera.add(this.listener);
    this.follow(input.origin);

    this.whale(input, now);

    this.mixClock += dt;
    if (this.mixClock < MIX_STEP) return;
    const step = this.mixClock;
    this.mixClock = 0;

    input.camera.getWorldPosition(this.listenerPos);
    this.shore(input, step);
    this.water(input, now);
    this.beds(input, step, now);
    this.birds(step, now);
    this.ships(input, step, now);
  }

  /** Whale moments fire one-shots at the whale. */
  private whale(input: AudioInput, now: number): void {
    const w = input.whale;
    if (!this.hasPrev) {
      this.prev.phase = w.phase;
      this.prev.phaseT = w.phaseT;
      this.hasPrev = true;
      return;
    }
    const events = whaleEvents(this.prev, w);
    this.prev.phase = w.phase;
    this.prev.phaseT = w.phaseT;
    if (events === 0) return;
    const x = w.x - input.origin.x;
    const z = w.z - input.origin.z;
    const near = 45 / (45 + Math.hypot(x - this.listenerPos.x, z - this.listenerPos.z));
    const r = this.rng;
    if (events & WHALE_SPOUT) this.shot(this.blow, x, 1.6, z, 0, 0, near * lerp(0.8, 1, r()), lerp(0.9, 1.06, r()), now);
    if (events & WHALE_BREACH_EXIT) this.splash(x, z, 0, near * lerp(0.6, 0.75, r()), lerp(0.68, 0.78, r()), now);
    if (events & WHALE_BREACH_SPLASH) this.splash(x, z, 1, near * lerp(0.9, 1, r()), lerp(0.58, 0.68, r()), now);
    if (events & WHALE_DIVE) this.splash(x, z, 0, near * lerp(0.2, 0.3, r()), lerp(0.85, 0.95, r()), now);
    if (events & WHALE_SURFACE) this.splash(x, z, 0, near * lerp(0.1, 0.16, r()), lerp(1.05, 1.2, r()), now);
  }

  private splash(x: number, z: number, hit: number, gain: number, rate: number, now: number): void {
    const voice = item(this.splashes, 0).isPlaying && !item(this.splashes, 1).isPlaying ? item(this.splashes, 1) : item(this.splashes, 0);
    const [offset, duration] = item(SPLASH_HITS, hit);
    this.shot(voice, x, 0.3, z, offset, duration, gain, rate, now);
  }

  private shot(voice: THREE.PositionalAudio, x: number, y: number, z: number, offset: number, duration: number, gain: number, rate: number, now: number): void {
    if (voice.isPlaying) voice.stop();
    voice.position.set(x, y, z);
    voice.offset = offset;
    voice.duration = duration > 0 ? duration : undefined;
    voice.setPlaybackRate(rate);
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(gain, now);
    voice.play();
    voice.updateMatrixWorld(true);
  }

  /** Nearest coast around the whale, refreshed a few times a second and eased. */
  private shore(input: AudioInput, step: number): void {
    const w = input.whale;
    this.shoreClock += step;
    if (this.shoreClock >= SHORE_STEP) {
      this.shoreClock = 0;
      const c = Math.max(0, input.shore.clearance(w.x, w.z));
      const away = input.shore.away(w.x, w.z);
      this.clearance = c;
      this.shoreTargetX = w.x - away.x * c - input.origin.x;
      this.shoreTargetZ = w.z - away.z * c - input.origin.z;
      if (!this.shoreKnown) {
        this.shoreX = this.shoreTargetX;
        this.shoreZ = this.shoreTargetZ;
        this.shoreKnown = true;
      }
    }
    this.shoreX = damp(this.shoreX, this.shoreTargetX, 1.5, step);
    this.shoreZ = damp(this.shoreZ, this.shoreTargetZ, 1.5, step);
  }

  /** Underwater: close the above-water mix through the lowpass and raise the underwater bed. */
  private water(input: AudioInput, now: number): void {
    muffle(input.signal.submersion, this.mix);
    setLevel(this.lowpass.frequency, this.mix.cutoff, now, 0.06);
    setLevel(this.aboveOut.gain, this.mix.above, now, 0.06);
    setLevel(this.below.gain, this.mix.below, now, 0.06);
  }

  private beds(input: AudioInput, step: number, now: number): void {
    const r = this.rng;
    // Gusts: wander toward a new strength every few seconds.
    this.gustTimer -= step;
    if (this.gustTimer <= 0) {
      this.gustTimer = 3 + r() * 6;
      this.gustTarget = lerp(0.7, 1.2, r());
      this.wind.setPlaybackRate(lerp(0.96, 1.04, r()));
    }
    this.gust = damp(this.gust, this.gustTarget, 0.4, step);
    const height = Math.max(0, this.listenerPos.y);
    const weather = input.weather;
    setLevel(this.wind.gain.gain, windGain(height) * this.gust * 0.6 * weatherWindGain(weather.wind), now, 0.6);
    setLevel(this.ocean.gain.gain, oceanGain(this.clearance) * seaGain(weather.sea), now, 0.6);
    setLevel(this.rain.gain.gain, rainGain(weather.rain), now, 1.5);

    const surf = surfGain(this.clearance);
    setLevel(this.surf.gain.gain, surf * 0.9, now, 0.5);
    this.surf.position.set(this.shoreX, 0, this.shoreZ);
    this.surf.updateMatrixWorld(true);

    setLevel(this.underwater.gain.gain, 0.75, now, 0.5);

    // Song comes and goes in long sessions.
    this.songTimer -= step;
    if (this.songTimer <= 0) {
      this.songOn = !this.songOn;
      this.songTimer = this.songOn ? 50 + r() * 60 : 25 + r() * 35;
      if (this.songOn) this.song.setPlaybackRate(lerp(0.94, 1.04, r()));
    }
    setLevel(this.song.gain.gain, this.songOn ? 0.8 : 0, now, 4);
  }

  /** Gull calls from above the nearest coast, more often the closer it is. */
  private birds(step: number, now: number): void {
    this.gullTimer -= step;
    if (this.gullTimer > 0) return;
    const g = gullGain(this.clearance);
    const r = this.rng;
    if (g < 0.02) {
      this.gullTimer = 3;
      return;
    }
    this.gullTimer = lerp(10, 2.5, g) * lerp(0.6, 1.4, r());
    const voice = item(this.gulls, 0).isPlaying ? item(this.gulls, 1) : item(this.gulls, 0);
    const [offset, duration] = item(GULL_CALLS, Math.floor(r() * GULL_CALLS.length) % GULL_CALLS.length);
    const along = (r() - 0.5) * 120;
    this.shot(
      voice,
      this.shoreX + along * 0.7,
      lerp(12, 35, r()),
      this.shoreZ - along * 0.7,
      offset,
      duration,
      g * lerp(0.35, 0.7, r()),
      lerp(0.92, 1.08, r()),
      now,
    );
  }

  /** Up to SHIP_SLOTS nearest ships get engine hum and bow wash; one sounds a rare horn. */
  private ships(input: AudioInput, step: number, now: number): void {
    const ships = input.ships;
    const lx = this.listenerPos.x;
    const lz = this.listenerPos.z;
    while (this.points.length < ships.length) this.points.push({ id: 0, x: 0, z: 0 });
    this.points.length = ships.length;
    for (let i = 0; i < ships.length; i++) {
      const ship = item(ships, i);
      ship.group.updateWorldMatrix(true, false);
      this.tmp.setFromMatrixPosition(ship.group.matrixWorld);
      const p = item(this.points, i);
      p.id = ship.spec.id;
      p.x = this.tmp.x;
      p.z = this.tmp.z;
    }
    const count = nearestShips(this.points, lx, lz, SHIP_SLOTS, SHIP_RANGE, this.nearest, this.nearestDist);

    // Release slots whose ship left the selection; they fade out where they are.
    for (let s = 0; s < this.slots.length; s++) {
      const slot = item(this.slots, s);
      if (slot.id < 0) continue;
      let kept = false;
      for (let k = 0; k < count; k++) if (item(this.points, this.nearest[k] ?? 0).id === slot.id) kept = true;
      if (!kept) slot.id = -1;
    }
    // Give newly selected ships a silent slot.
    for (let k = 0; k < count; k++) {
      const id = item(this.points, this.nearest[k] ?? 0).id;
      let free: ShipSlot | null = null;
      let taken = false;
      for (let s = 0; s < this.slots.length; s++) {
        const slot = item(this.slots, s);
        if (slot.id === id) taken = true;
        else if (!free && slot.id < 0 && slot.level < 0.01) free = slot;
      }
      if (taken || !free) continue;
      free.id = id;
      // Each ship keeps its own engine pitch.
      const pitch = lerp(0.85, 1.12, hash(id, 0x454e47) / 0x100000000);
      free.engine.setPlaybackRate(pitch);
      free.wash.setPlaybackRate(lerp(0.95, 1.05, hash(id, 0x57534) / 0x100000000));
      if (!free.engine.isPlaying) {
        free.engine.offset = this.rng() * (free.engine.buffer?.duration ?? 0);
        free.engine.play();
        free.wash.play();
      }
    }

    for (let s = 0; s < this.slots.length; s++) {
      const slot = item(this.slots, s);
      let distance = Infinity;
      if (slot.id >= 0) {
        for (let k = 0; k < count; k++) {
          const p = item(this.points, this.nearest[k] ?? 0);
          if (p.id !== slot.id) continue;
          distance = this.nearestDist[k] ?? 0;
          slot.engine.position.set(p.x, 1.5, p.z);
          slot.wash.position.set(p.x, 0, p.z);
        }
      }
      const target = slot.id >= 0 ? 1 : 0;
      slot.level = damp(slot.level, target, 1.2, step);
      if (!slot.engine.isPlaying) continue;
      if (slot.id < 0 && slot.level < 0.005) {
        slot.engine.stop();
        slot.wash.stop();
        continue;
      }
      setLevel(slot.engine.gain.gain, (slot.id >= 0 ? engineGain(distance) : 0) * 0.85 * slot.level, now);
      setLevel(slot.wash.gain.gain, (slot.id >= 0 ? washGain(distance) : 0) * 0.6 * slot.level, now);
      slot.engine.updateMatrixWorld(true);
      slot.wash.updateMatrixWorld(true);
    }

    this.hornTimer -= step;
    if (this.hornTimer > 0) return;
    if (count === 0) {
      this.hornTimer = 20;
      return;
    }
    this.hornTimer = 90 + this.rng() * 110;
    const p = item(this.points, this.nearest[0] ?? 0);
    const d = this.nearestDist[0] ?? 0;
    this.shot(this.horn, p.x, 6, p.z, 0, 0, hornGain(d) * lerp(0.6, 0.85, this.rng()), lerp(0.94, 1.04, this.rng()), now);
  }

  dispose(): void {
    if (this.sleepTimer !== null) clearTimeout(this.sleepTimer);
    this.unsubscribe?.();
    for (const voice of this.voices) if (voice.isPlaying) voice.stop();
    this.listener.removeFromParent();
    this.context.close().catch(() => {
      // The page is going away; a context that will not close goes with it.
    });
  }
}

export class OceanAudio {
  enabled: boolean;
  volume: number;
  private readonly seed: number;
  private engine: SoundEngine | null = null;
  private awaitingGesture = false;

  constructor(settings: AudioSettings = { enabled: false, volume: 0.35 }, seed = 0) {
    this.enabled = settings.enabled;
    this.volume = settings.volume;
    this.seed = seed;
  }

  settings(): AudioSettings {
    return { enabled: this.enabled, volume: this.volume };
  }

  async sync(active: boolean): Promise<void> {
    if (!this.enabled || !active) {
      this.engine?.sleep();
      return;
    }
    if (!this.engine) {
      // Remembered "on" from an earlier visit still waits for this visit's first tap or key.
      // Older browsers have no record of activation; they play on the enabling tap.
      if ('userActivation' in navigator && !navigator.userActivation.hasBeenActive) {
        this.waitForGesture();
        return;
      }
      if (typeof AudioContext === 'undefined' && !('webkitAudioContext' in window)) return;
      this.engine = new SoundEngine(this.seed);
    }
    await this.engine.wake(this.volume);
  }

  private waitForGesture(): void {
    if (this.awaitingGesture) return;
    this.awaitingGesture = true;
    const start = () => {
      window.removeEventListener('pointerdown', start, true);
      window.removeEventListener('keydown', start, true);
      this.awaitingGesture = false;
      this.sync(!document.hidden).catch(() => {
        // Sound stays off when the context cannot start; the button still reflects the choice.
      });
    };
    window.addEventListener('pointerdown', start, true);
    window.addEventListener('keydown', start, true);
  }

  /** Per frame, before render. Does nothing until sound is on and loaded. */
  update(_dt: number, input: AudioInput): void {
    if (!this.enabled || !this.engine) return;
    this.engine.update(input);
  }

  stats(): number[] {
    return [this.enabled ? 1 : 0, this.engine?.loaded ? 1 : 0, this.engine?.playing() ?? 0];
  }

  dispose(): void {
    this.engine?.dispose();
    this.engine = null;
  }
}
