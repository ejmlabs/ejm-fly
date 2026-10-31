import * as THREE from 'three';
import { hash, random } from './rng.js';
import { makeNoise2D } from './noise.js';
import { clamp, lerp, smoothstep } from './math.js';
import { ATLAS_BODY_V, BLOWHOLE_U, BODY_LENGTH, SPLASHGUARD_U, WHALE_LENGTH, crossSection, sampleProfile, type Profile } from './whale-model.js';
import { item } from './item.js';
import { context2d } from './canvas.js';

export interface WhaleSkin {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  dispose: () => void;
}

// sRGB 0–1. Blue whales are slate grey, mottled with paler grey all over, a little lighter beneath; a film of
// diatoms tints the belly yellowish on some animals (hence "sulphur-bottom"). The greys carry only a trace of blue:
// the scene's sky light is strongly blue, so a blue albedo lit by it comes out saturated navy instead of slate.
const BACK = [0.3, 0.34, 0.37];
const FLANK = [0.38, 0.42, 0.45];
const BELLY = [0.54, 0.57, 0.58];
const MOTTLE = [0.62, 0.67, 0.7];
const DARK = [0.23, 0.26, 0.29];
const DIATOM = [0.62, 0.58, 0.42];
const SCAR = [0.68, 0.71, 0.73];
const BARNACLE = [0.6, 0.59, 0.56];

/**
 * Runtime-generated skin atlas: blue-grey mottling, a paler belly with diatom film, 55 to 90 throat grooves
 * to the navel, jaw crease, eye, blowholes and splashguard, and scars, plus a matching normal map.
 * Layout follows the UVs from whale-model: body on top, flippers and flukes below.
 */
/** Grooves per radian around the throat: about 70 across its width. */
const GROOVES_PER_RADIAN = 20.5;

export function createWhaleSkin(seed: number, size: number): WhaleSkin {
  const W = size;
  const H = size;
  const rng = random(hash(seed, 0x5a1e));
  const n0 = makeNoise2D(seed, 31);
  const n1 = makeNoise2D(seed, 32);
  const color = new Float32Array(W * H * 3);
  const height = new Float32Array(W * H);

  const bodyRows = Math.floor(H * (1 - ATLAS_BODY_V));
  const profiles: Profile[] = [];
  for (let px = 0; px < W; px++) profiles.push(sampleProfile(clamp((px + 0.5) / W, 0.004, 1)));
  const point = { y: 0, z: 0 };
  // How much diatom film this animal carries: none on some, plenty on others.
  const diatoms = rng() ** 1.5;

  // Surface noise on the 3D position, so the ventral seam does not show.
  const field = (x: number, y: number, z: number, f: number) => 0.5 * (n0(x * f, y * f + z * 0.5 * f) + n1(z * f + 19.1, x * f - y * 0.5 * f));

  // Low-frequency fields vary over tens of centimetres: sample them on a coarse
  // grid and interpolate, which keeps generation cheap at 1024².
  const G = Math.max(1, Math.round(W / 256));
  const gw = Math.ceil(W / G) + 1;
  const gh = Math.ceil(bodyRows / G) + 1;
  const gLow = new Float32Array(gw * gh);
  const gMid = new Float32Array(gw * gh);
  const gFleck = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const v = 1 - (gy * G + 0.5) / H;
    const theta = Math.PI + ((v - ATLAS_BODY_V) / (1 - ATLAS_BODY_V)) * Math.PI * 2;
    for (let gx = 0; gx < gw; gx++) {
      const p = item(profiles, Math.min(W - 1, gx * G));
      crossSection(p, theta, point);
      const k = gy * gw + gx;
      gLow[k] = field(p.x, point.y, point.z, 0.45);
      gMid[k] = field(p.x, point.y, point.z, 1.6);
      gFleck[k] = field(p.x, point.y, point.z, 3.1);
    }
  }
  const coarse = (grid: Float32Array, px: number, py: number) => {
    const fx = px / G;
    const fy = py / G;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const k = y0 * gw + x0;
    return lerp(lerp(grid[k] ?? 0, grid[k + 1] ?? 0, tx), lerp(grid[k + gw] ?? 0, grid[k + gw + 1] ?? 0, tx), ty);
  };

  /* ---- body region ---- */
  for (let py = 0; py < bodyRows; py++) {
    const v = 1 - (py + 0.5) / H;
    const theta = Math.PI + ((v - ATLAS_BODY_V) / (1 - ATLAS_BODY_V)) * Math.PI * 2;
    const c = Math.cos(theta);
    const flank = Math.abs(Math.sin(theta));
    for (let px = 0; px < W; px++) {
      const p = item(profiles, px);
      const u = p.u;
      crossSection(p, theta, point);
      const { y, z } = point;
      const x = p.x;
      const i = py * W + px;
      const low = coarse(gLow, px, py);
      const mid = coarse(gMid, px, py);
      const fine = n0(x * 9 + z * 3, y * 9 - z * 2);

      // Weak countershading: a little lighter beneath, darkest along the back.
      const below = 1 - smoothstep(-0.55, 0.15, c + low * 0.25);
      const sideTone = 1 - smoothstep(0.1, 0.9, c);
      let r = lerp(lerp(BACK[0] ?? 0, FLANK[0] ?? 0, sideTone), BELLY[0] ?? 0, below);
      let g = lerp(lerp(BACK[1] ?? 0, FLANK[1] ?? 0, sideTone), BELLY[1] ?? 0, below);
      let b = lerp(lerp(BACK[2] ?? 0, FLANK[2] ?? 0, sideTone), BELLY[2] ?? 0, below);
      // Mottling: irregular pale blotches and darker patches all over, thickest on the back and flanks behind
      // the head, sparse on the head itself.
      const body = smoothstep(0.12, 0.3, u) * (1 - 0.4 * smoothstep(0.85, 1, u));
      // Blotches merge into larger, softer patches rather than spots.
      const fleckField = 0.6 * coarse(gFleck, px, py) + 0.7 * mid + 0.2 * low;
      const pale = smoothstep(0.12, 0.42, fleckField) * (0.5 + 0.5 * smoothstep(-0.2, 0.6, low)) * body;
      const dark = smoothstep(0.22, 0.45, -fleckField - 0.2 * low) * 0.6 * body;
      r = lerp(lerp(r, MOTTLE[0] ?? 0, pale * 0.55), DARK[0] ?? 0, dark * 0.8);
      g = lerp(lerp(g, MOTTLE[1] ?? 0, pale * 0.55), DARK[1] ?? 0, dark * 0.8);
      b = lerp(lerp(b, MOTTLE[2] ?? 0, pale * 0.55), DARK[2] ?? 0, dark * 0.8);
      // Diatom film: soft yellowish patches on the belly.
      const film = below * smoothstep(0.05, 0.45, low + 0.3 * mid) * diatoms;
      r = lerp(r, DIATOM[0] ?? 0, film * 0.55);
      g = lerp(g, DIATOM[1] ?? 0, film * 0.55);
      b = lerp(b, DIATOM[2] ?? 0, film * 0.55);
      const grain = 1 + 0.06 * low + 0.04 * mid + 0.03 * fine;
      r *= grain;
      g *= grain;
      b *= grain;
      let h = 0.12 * fine + 0.25 * mid + 0.15 * pale;

      // Ventral grooves: 55 to 90 of them from the chin back to the navel, converging forward.
      const pleatFade = smoothstep(0.02, 0.06, u) * (1 - smoothstep(0.46, 0.52, u + 0.03 * low)) * (1 - smoothstep(-0.3, 0.02, c));
      if (pleatFade > 0) {
        const ang = Math.atan2(z, -(y - p.mid));
        const wave = ang * GROOVES_PER_RADIAN + 0.06 * Math.sin(u * 40 + ang * 3) + 0.04 * mid;
        const groove = (0.5 + 0.5 * Math.cos(wave * Math.PI * 2)) ** 6;
        h -= 1.6 * groove * pleatFade;
        const shade = 1 - 0.22 * groove * pleatFade;
        r *= shade;
        g *= shade;
        b *= shade;
      }

      // Mouth line: dark crease from rostrum back toward the eye.
      if (p.jaw > 0) {
        const d = y - p.jawY;
        const line = Math.exp(-((d / (0.0017 * WHALE_LENGTH)) ** 2)) * p.jaw * smoothstep(0.25, 0.6, flank);
        h -= 2.2 * line;
        const shade = 1 - 0.65 * line;
        r *= shade;
        g *= shade;
        b *= shade;
      }

      color[i * 3] = r;
      color[i * 3 + 1] = g;
      color[i * 3 + 2] = b;
      height[i] = h;
    }
  }

  /* ---- flipper and fluke region ---- */
  for (let py = bodyRows; py < H; py++) {
    const v = 1 - (py + 0.5) / H;
    const phi = (v / ATLAS_BODY_V) * Math.PI * 2;
    const top = Math.sin(phi) > 0;
    const k = 0.5 + 0.5 * Math.cos(phi);
    for (let px = 0; px < W; px++) {
      const U = (px + 0.5) / W;
      const i = py * W + px;
      let r: number;
      let g: number;
      let b: number;
      // Flippers and flukes: blue-grey like the body and a little paler beneath, mottled, with a pale edge
      // here and there on the flippers.
      const flipper = U < 0.5;
      const sx = flipper ? U / 0.5 : Math.abs((U - 0.5) / 0.25 - 1);
      const nz = n0(sx * 7 + (flipper ? 0 : 13), k * 3 + (top ? 0 : 9));
      const fine = n1(sx * 40, k * 14);
      const under = top ? 0 : 0.55;
      r = lerp(FLANK[0] ?? 0, BELLY[0] ?? 0, under);
      g = lerp(FLANK[1] ?? 0, BELLY[1] ?? 0, under);
      b = lerp(FLANK[2] ?? 0, BELLY[2] ?? 0, under);
      // Flukes stay a fairly even grey; flippers mottle more and sometimes pale toward the tip.
      const pale = smoothstep(0.15, 0.45, nz) * (flipper ? 0.45 : 0.18) + (flipper ? 0.35 * smoothstep(0.75, 0.95, sx) * smoothstep(0.1, 0.4, nz + 0.3) : 0);
      r = lerp(r, MOTTLE[0] ?? 0, pale);
      g = lerp(g, MOTTLE[1] ?? 0, pale);
      b = lerp(b, MOTTLE[2] ?? 0, pale);
      const grain = 1 + 0.06 * nz + 0.04 * fine;
      r *= grain;
      g *= grain;
      b *= grain;
      const h = 0.2 * fine;
      color[i * 3] = r;
      color[i * 3 + 1] = g;
      color[i * 3 + 2] = b;
      height[i] = h;
    }
  }

  /* ---- stamped details on the body ---- */
  // Texel footprint of a radius-r disc at body coordinate u.
  const radiusAt = (u: number) => {
    const p = sampleProfile(u);
    return Math.max(0.05, (p.width + (p.top - p.bot) * 0.5) * 0.5);
  };
  const texel = (u: number, theta: number) => ({
    px: u * W,
    py: (1 - (ATLAS_BODY_V + (1 - ATLAS_BODY_V) * ((theta - Math.PI) / (Math.PI * 2)))) * H,
  });
  type Stamp = (dx: number, dy: number, i: number) => void;
  const stamp = (u: number, theta: number, r: number, reach: number, fn: Stamp) => {
    const t = texel(u, ((theta - Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) + Math.PI);
    const ru = (r / BODY_LENGTH) * W;
    const rv = (r / radiusAt(u) / (Math.PI * 2)) * (1 - ATLAS_BODY_V) * H;
    const ex = Math.ceil(ru * reach);
    const ey = Math.ceil(rv * reach);
    for (let oy = -ey; oy <= ey; oy++) {
      const py = Math.floor(t.py) + oy;
      if (py < 0 || py >= bodyRows) continue;
      for (let ox = -ex; ox <= ex; ox++) {
        const px = Math.floor(t.px) + ox;
        if (px < 0 || px >= W) continue;
        fn((px + 0.5 - t.px) / ru, (py + 0.5 - t.py) / rv, py * W + px);
      }
    }
  };
  const tint = (i: number, rgb: number[], a: number) => {
    color[i * 3] = lerp(color[i * 3] ?? 0, rgb[0] ?? 0, a);
    color[i * 3 + 1] = lerp(color[i * 3 + 1] ?? 0, rgb[1] ?? 0, a);
    color[i * 3 + 2] = lerp(color[i * 3 + 2] ?? 0, rgb[2] ?? 0, a);
  };
  const thetaAt = (side: 1 | -1, fromTop: number) => Math.PI * 2 + side * fromTop; // 2π = dorsal midline
  const barnacle = (u: number, theta: number, r: number) => { stamp(u, theta, r, 1.6, (dx, dy, i) => {
      const d = Math.hypot(dx, dy);
      if (d > 1.5) return;
      const ring = Math.exp(-(((d - 0.7) / 0.28) ** 2));
      const core = Math.exp(-((d / 0.35) ** 2));
      tint(i, BARNACLE, clamp(ring * 0.45 + core * 0.15, 0, 1));
      tint(i, [0.35, 0.34, 0.32], core * 0.5);
      height[i] = (height[i] ?? 0) + 1.6 * ring + 0.8 * core;
    }); };

  // Blue whales carry few barnacles: a handful on the chin, the flipper roots and the fluke edges.
  for (let n = 0; n < 6; n++) barnacle(0.004 + rng() * 0.05, Math.PI + (rng() - 0.5) * 2.2, 0.012 + rng() * 0.015);

  // Eyes, just above the end of the mouth line.
  for (const side of [1, -1] as const) {
    // At the corner of the mouth.
    const u = 0.228;
    const p = sampleProfile(u);
    let best = Math.PI * 0.5;
    let bestD = Infinity;
    for (let a = 0.6; a < 2.4; a += 0.01) {
      crossSection(p, a, point);
      const d = Math.abs(point.y - (p.jawY + 0.009 * WHALE_LENGTH));
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    stamp(u, thetaAt(side, best), 0.1, 2.6, (dx, dy, i) => {
      const d = Math.hypot(dx, dy * 1.3);
      tint(i, [0.03, 0.03, 0.035], clamp(1.6 - d * 1.6, 0, 1));
      tint(i, [0.4, 0.42, 0.44], Math.exp(-(((d - 1.35) / 0.3) ** 2)) * 0.35);
      height[i] = (height[i] ?? 0) + 3 * Math.exp(-((d / 1.6) ** 2));
    });
  }

  // Paired blowhole slits behind the splashguard (the guard itself is in the geometry; this darkens its rim).
  {
    const u = BLOWHOLE_U;
    for (const side of [1, -1] as const) {
      stamp(u, thetaAt(side, 0.07), 0.2, 1.4, (dx, dy, i) => {
        const slit = Math.exp(-((dx / 1) ** 2) - (dy / 0.22) ** 2);
        tint(i, [0.03, 0.035, 0.04], slit * 0.9);
        height[i] = (height[i] ?? 0) - 4 * slit;
      });
    }
    stamp(SPLASHGUARD_U, Math.PI * 2, 0.35, 1.5, (dx, dy, i) => {
      height[i] = (height[i] ?? 0) + 2.5 * Math.exp(-((dx / 0.45) ** 2) - (dy / 1) ** 2);
      tint(i, DARK, 0.25 * Math.exp(-((dx / 0.45) ** 2) - (dy / 1) ** 2));
    });
  }

  // Oval scars from cookie-cutter shark bites, pale and healed, scattered over the flanks.
  for (let n = 0; n < 14; n++) {
    const u = 0.15 + rng() * 0.7;
    const theta = Math.PI * 2 + (rng() < 0.5 ? -1 : 1) * (0.4 + rng() * 1.8);
    const r = 0.025 + rng() * 0.03;
    const healed = 0.35 + rng() * 0.4;
    stamp(u, theta, r, 1.8, (dx, dy, i) => {
      const d = Math.hypot(dx, dy * 1.4);
      const a = clamp(1.3 - d, 0, 1) * healed;
      tint(i, SCAR, a);
      height[i] = (height[i] ?? 0) - 0.8 * a;
    });
  }

  // Long healed scrapes on the flanks.
  for (let n = 0; n < 5; n++) {
    let u = 0.25 + rng() * 0.5;
    let theta = Math.PI * 2 + (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 1.2);
    const du = (rng() - 0.5) * 0.004;
    const dt = (rng() - 0.5) * 0.03;
    const steps = 10 + Math.floor(rng() * 30);
    const strength = 0.18 + rng() * 0.25;
    for (let sIdx = 0; sIdx < steps; sIdx++) {
      stamp(u, theta, 0.014, 1.8, (dx, dy, i) => {
        const a = Math.exp(-(dx * dx + dy * dy)) * strength;
        tint(i, SCAR, a * 0.8);
        height[i] = (height[i] ?? 0) - 0.6 * a;
      });
      u += du + 0.0015;
      theta += dt;
    }
  }

  // Rake marks on the fluke underside: parallel pale lines.
  {
    const lines = 3 + Math.floor(rng() * 3);
    const z0 = (rng() - 0.5) * 1.2;
    for (let l = 0; l < lines; l++) {
      for (let t = 0; t < 1; t += 0.004) {
        const zf = z0 + (t - 0.5) * 0.6 + l * 0.05;
        const k = 0.2 + t * 0.55;
        const phi = Math.PI + Math.acos(clamp(2 * k - 1, -1, 1));
        const px = Math.floor((0.5 + 0.25 * (zf + 1)) * W);
        const py = Math.floor((1 - (phi / (Math.PI * 2)) * ATLAS_BODY_V) * H);
        for (let o = -1; o <= 1; o++) {
          const ii = clamp(py + o, bodyRows, H - 1) * W + clamp(px, 0, W - 1);
          tint(ii, [0.75, 0.75, 0.73], 0.5);
        }
      }
    }
  }

  /* ---- encode ---- */
  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = W;
  albedoCanvas.height = H;
  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = W;
  normalCanvas.height = H;
  const actx = context2d(albedoCanvas);
  const nctx = context2d(normalCanvas);
  const albedo = actx.createImageData(W, H);
  const normal = nctx.createImageData(W, H);
  // Height units are millimetres-ish; scale against the ~1 cm texel.
  const strength = 0.55 * (W / 1024);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      albedo.data[i * 4] = clamp(Math.round((color[i * 3] ?? 0) * 255), 0, 255);
      albedo.data[i * 4 + 1] = clamp(Math.round((color[i * 3 + 1] ?? 0) * 255), 0, 255);
      albedo.data[i * 4 + 2] = clamp(Math.round((color[i * 3 + 2] ?? 0) * 255), 0, 255);
      albedo.data[i * 4 + 3] = 255;
      const l = height[py * W + Math.max(0, px - 1)] ?? 0;
      const rr = height[py * W + Math.min(W - 1, px + 1)] ?? 0;
      const up = height[Math.max(0, py - 1) * W + px] ?? 0;
      const dn = height[Math.min(H - 1, py + 1) * W + px] ?? 0;
      // Canvas rows run down while V runs up (flipY), hence the sign on dy.
      const nx = -(rr - l) * 0.5 * strength;
      const ny = (dn - up) * 0.5 * strength;
      const len = Math.hypot(nx, ny, 1);
      normal.data[i * 4] = Math.round((nx / len * 0.5 + 0.5) * 255);
      normal.data[i * 4 + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      normal.data[i * 4 + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      normal.data[i * 4 + 3] = 255;
    }
  }
  actx.putImageData(albedo, 0, 0);
  nctx.putImageData(normal, 0, 0);

  const map = new THREE.CanvasTexture(albedoCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const normalMap = new THREE.CanvasTexture(normalCanvas);
  normalMap.anisotropy = 4;
  return {
    map,
    normalMap,
    dispose() {
      map.dispose();
      normalMap.dispose();
    },
  };
}

