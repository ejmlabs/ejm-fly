import * as THREE from 'three';
import { clamp } from './math.js';
import { patchShader } from './shader-patch.js';

/**
 * The scene's one tone curve: three's ACES filmic fit (`tonemapping_pars_fragment`), here on the CPU and inverted for
 * shaders. Every material draws scene radiance and the output applies the curve once, after the bloom and the grade.
 * A material authored in display colours (the land and its measured haze, foam, stars, overlays) ends with
 * `sceneFromDisplay`, so it still draws exactly as authored.
 */

// three's matrices, column-major like the GLSL source.
const ACES_IN = [0.59719, 0.076, 0.0284, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777];
const ACES_OUT = [1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602];

/** The fit's output is held under this before inverting, so pure white is a finite radiance (about 18 at noon). */
const FIT_CEILING = 0.985;

function mul(m: readonly number[], x: number, y: number, z: number, out: number[]): void {
  out[0] = (m[0] ?? 0) * x + (m[3] ?? 0) * y + (m[6] ?? 0) * z;
  out[1] = (m[1] ?? 0) * x + (m[4] ?? 0) * y + (m[7] ?? 0) * z;
  out[2] = (m[2] ?? 0) * x + (m[5] ?? 0) * y + (m[8] ?? 0) * z;
}

function fit(v: number): number {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
}

/** The input `fit` maps to `y`: the positive root of its quadratic. */
function unfit(y: number): number {
  const t = clamp(y, 0, FIT_CEILING);
  const a = 1 - 0.983729 * t;
  const b = 0.0245786 - 0.432951 * t;
  const c = 0.000090537 + 0.238081 * t;
  return (Math.sqrt(b * b + 4 * a * c) - b) / (2 * a);
}

/** The inverse of a column-major 3 by 3 matrix, column-major. */
function invert(m: readonly number[]): number[] {
  const [a = 0, d = 0, g = 0, b = 0, e = 0, h = 0, c = 0, f = 0, i = 0] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    (e * i - f * h) / det, (f * g - d * i) / det, (d * h - e * g) / det,
    (c * h - b * i) / det, (a * i - c * g) / det, (b * g - a * h) / det,
    (b * f - c * e) / det, (c * d - a * f) / det, (a * e - b * d) / det,
  ];
}

const ACES_IN_INVERSE = invert(ACES_IN);
const ACES_OUT_INVERSE = invert(ACES_OUT);

const va = [0, 0, 0];
const vb = [0, 0, 0];

/** Linear display colour that the output's curve produces for scene radiance `c` at `exposure`. */
export function acesFilmic(c: THREE.Color, exposure: number, out = new THREE.Color()): THREE.Color {
  const e = exposure / 0.6;
  mul(ACES_IN, c.r * e, c.g * e, c.b * e, va);
  mul(ACES_OUT, fit(va[0] ?? 0), fit(va[1] ?? 0), fit(va[2] ?? 0), vb);
  return out.setRGB(clamp(vb[0] ?? 0, 0, 1), clamp(vb[1] ?? 0, 0, 1), clamp(vb[2] ?? 0, 0, 1));
}

/**
 * Scene radiance that the output's curve maps to the linear display colour `target` at `exposure`, so a palette
 * can be chosen as it should look on screen. A colour the curve cannot reach (it greys strong teals) comes back as
 * the nearest it can.
 */
export function radianceFor(target: THREE.Color, exposure: number, out = new THREE.Color()): THREE.Color {
  mul(ACES_OUT_INVERSE, target.r, target.g, target.b, va);
  mul(ACES_IN_INVERSE, unfit(va[0] ?? 0), unfit(va[1] ?? 0), unfit(va[2] ?? 0), vb);
  const k = 0.6 / Math.max(1e-3, exposure);
  return out.setRGB(Math.max(0, vb[0] ?? 0) * k, Math.max(0, vb[1] ?? 0) * k, Math.max(0, vb[2] ?? 0) * k);
}

/** The output's exposure, written once a frame; shaders that convert display colours read it. */
export const displayExposure = { value: 1 };

const glslMat3 = (m: readonly number[]) => `mat3( ${m.map((v) => v.toFixed(6)).join(', ')} )`;

/** GLSL: `sceneFromDisplay( display )`, `radianceFor` on the GPU. */
export const SCENE_FROM_DISPLAY_GLSL = /* glsl */ `
uniform float displayExposure;
vec3 sceneFromDisplay( vec3 display ) {
  vec3 y = clamp( ${glslMat3(ACES_OUT_INVERSE)} * display, 0.0, ${FIT_CEILING.toFixed(3)} );
  vec3 a = 1.0 - 0.983729 * y;
  vec3 b = 0.0245786 - 0.432951 * y;
  vec3 c = 0.000090537 + 0.238081 * y;
  vec3 v = ( sqrt( b * b + 4.0 * a * c ) - b ) / ( 2.0 * a );
  return max( ${glslMat3(ACES_IN_INVERSE)} * v, 0.0 ) * 0.6 / max( displayExposure, 1e-3 );
}
`;

/** The end of a display-authored ShaderMaterial's fragment shader: to scene radiance, then three's own output steps. */
export const DRAW_AS_AUTHORED_GLSL = /* glsl */ `gl_FragColor.rgb = sceneFromDisplay( gl_FragColor.rgb );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>`;

/** Makes a built-in material authored in display colours (foam, stars, sprites) draw as authored through the curve. */
export function drawAsAuthored<M extends THREE.Material>(material: M): M {
  material.toneMapped = true;
  material.onBeforeCompile = (shader) => {
    const fragment = patchShader(shader.fragmentShader, [
      { find: '#include <tonemapping_fragment>', replace: 'gl_FragColor.rgb = sceneFromDisplay( gl_FragColor.rgb );\n#include <tonemapping_fragment>' },
    ]);
    if (fragment === null) throw new Error(`${material.type} has no tone mapping step to draw through`);
    shader.fragmentShader = `${SCENE_FROM_DISPLAY_GLSL}\n${fragment}`;
    shader.uniforms['displayExposure'] = displayExposure;
  };
  return material;
}
