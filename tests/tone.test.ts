import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { SCENE_FROM_DISPLAY_GLSL, acesFilmic, radianceFor } from '../src/tone.js';

test('radianceFor inverts the output curve exactly for the colours the scene is authored in', () => {
  for (const exposure of [0.2, 0.42, 0.55]) {
    for (const hex of [0x6a7f45, 0x34492c, 0x77716a, 0xd2c3a0, 0xe9eff2, 0x0b1220, 0x7a9bb0, 0x2f8590, 0xffc878]) {
      const display = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
      const back = acesFilmic(radianceFor(display, exposure), exposure);
      for (const c of ['r', 'g', 'b'] as const) assert.ok(Math.abs(back[c] - display[c]) < 1e-4, `${hex.toString(16)} at ${String(exposure)}: ${c}`);
    }
  }
});

test('white stays a finite radiance, and the darker the exposure the more light it takes', () => {
  const white = new THREE.Color(1, 1, 1);
  const noon = radianceFor(white, 0.44);
  const night = radianceFor(white, 0.2);
  assert.ok(Number.isFinite(noon.r) && noon.r < 40, `white is ${String(noon.r)}`);
  assert.ok(night.g > noon.g);
});

test('the shader inverse is written from the same curve', () => {
  assert.ok(SCENE_FROM_DISPLAY_GLSL.includes('uniform float displayExposure;'));
  assert.ok(SCENE_FROM_DISPLAY_GLSL.includes('0.983729') && SCENE_FROM_DISPLAY_GLSL.includes('0.238081'));
});

test('no material opts out of the tone curve: display colours convert instead', async () => {
  const src = resolve(import.meta.dirname, '../src');
  for (const name of await readdir(src)) {
    if (!name.endsWith('.ts')) continue;
    const source = await readFile(resolve(src, name), 'utf8');
    assert.equal(/toneMapped:\s*false/.test(source), false, `${name} draws outside the curve; use drawAsAuthored or DRAW_AS_AUTHORED_GLSL`);
  }
});
