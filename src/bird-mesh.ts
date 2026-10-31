import * as THREE from 'three';
import { item } from './item.js';

export interface Species {
  name: 'gull' | 'tern' | 'albatross';
  /** Half wingspan (m). */
  span: number;
  /** Root chord of the wing (m). */
  chord: number;
  /** Body length (m). */
  length: number;
  /** Body radius (m). */
  radius: number;
  /** How far the hand of the wing sweeps back, as a fraction of the half span. */
  sweep: number;
  forkedTail: boolean;
  body: number;
  back: number;
  tip: number;
  accent: number;
  /** Cruise speed (m/s), flap rate (rad/s) and how much of the time the wings are held still (0..1). */
  speed: number;
  rate: number;
  glide: number;
}

export const SPECIES: readonly Species[] = [
  { name: 'gull', span: 0.95, chord: 0.34, length: 1.0, radius: 0.13, sweep: 0.5, forkedTail: false, body: 0xf4f1ea, back: 0xa7b2bb, tip: 0x2c3541, accent: 0xe8b04a, speed: 9, rate: 7.5, glide: 0.25 },
  { name: 'tern', span: 0.75, chord: 0.22, length: 0.85, radius: 0.09, sweep: 0.62, forkedTail: true, body: 0xf7f5f0, back: 0xc2cbd2, tip: 0x3a4450, accent: 0xe0643c, speed: 11, rate: 10, glide: 0.1 },
  { name: 'albatross', span: 1.9, chord: 0.3, length: 1.15, radius: 0.15, sweep: 0.2, forkedTail: false, body: 0xf6f3ec, back: 0x6f7b88, tip: 0x2a323d, accent: 0xe6b9b0, speed: 13, rate: 4.2, glide: 0.92 },
];

/** Triangles for each level of detail: body sides and wing segments. */
const LEVELS = [
  { sides: 8, wingSegments: 6, rings: true },
  { sides: 5, wingSegments: 3, rings: true },
  { sides: 3, wingSegments: 2, rings: false },
] as const;

// Body profile along the length (z from -0.5 to 0.5 of the length): [position, radius factor].
const PROFILE: readonly (readonly [number, number])[] = [
  [-0.5, 0.05], [-0.32, 0.5], [-0.1, 1], [0.12, 0.9], [0.27, 0.55], [0.36, 0.55], [0.45, 0.3], [0.52, 0],
];
const BEAK_FROM = 0.42;

class Builder {
  readonly position: number[] = [];
  readonly color: number[] = [];
  readonly wing: number[] = [];
  private readonly c = new THREE.Color();

  vertex(x: number, y: number, z: number, hex: number, wing: number): number {
    this.c.setHex(hex, THREE.SRGBColorSpace);
    this.position.push(x, y, z);
    this.color.push(this.c.r, this.c.g, this.c.b);
    this.wing.push(wing);
    return this.wing.length - 1;
  }

  geometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3));
    geometry.setAttribute('wing', new THREE.Float32BufferAttribute(this.wing, 1));
    geometry.computeVertexNormals();
    return geometry;
  }
}

/** Build one species at one level of detail: body, head, beak, tail and two jointed wings in one geometry. */
export function buildBird(species: Species, level: 0 | 1 | 2): THREE.BufferGeometry {
  const { sides, wingSegments, rings } = LEVELS[level];
  const b = new Builder();
  const tri = (pa: readonly number[], pb: readonly number[], pc: readonly number[], hex: [number, number, number], w: [number, number, number] = [0, 0, 0]) => {
    b.vertex(pa[0] ?? 0, pa[1] ?? 0, pa[2] ?? 0, hex[0], w[0]);
    b.vertex(pb[0] ?? 0, pb[1] ?? 0, pb[2] ?? 0, hex[1], w[1]);
    b.vertex(pc[0] ?? 0, pc[1] ?? 0, pc[2] ?? 0, hex[2], w[2]);
  };

  // Body: a lathe along z. Tiny levels drop the middle rings.
  const profile = rings ? PROFILE : [item(PROFILE, 0), item(PROFILE, 2), item(PROFILE, 5), item(PROFILE, 7)];
  const ringPoint = (i: number, s: number): number[] => {
    const [along, factor] = item(profile, i);
    const angle = (s / sides) * Math.PI * 2;
    const r = species.radius * factor;
    return [Math.cos(angle) * r * 0.9, Math.sin(angle) * r * 0.85, along * species.length];
  };
  for (let i = 0; i < profile.length - 1; i++) {
    const beak = item(profile, i)[0] >= BEAK_FROM;
    for (let s = 0; s < sides; s++) {
      const a = ringPoint(i, s), c = ringPoint(i, s + 1), d = ringPoint(i + 1, s), e = ringPoint(i + 1, s + 1);
      const top = Math.sin(((s + 0.5) / sides) * Math.PI * 2) > 0.2;
      const hex = beak ? species.accent : top ? species.back : species.body;
      tri(a, d, c, [hex, hex, hex]);
      tri(c, d, e, [hex, hex, hex]);
    }
  }

  // Tail: a flat wedge, notched for a tern.
  const tailZ = -0.5 * species.length;
  const tailLength = species.length * 0.42;
  const tailHalf = species.chord * (species.forkedTail ? 0.45 : 0.5);
  const white = species.body;
  if (species.forkedTail) {
    tri([0, 0, tailZ + 0.05], [-tailHalf, 0, tailZ - tailLength], [-tailHalf * 0.15, 0, tailZ - tailLength * 0.35], [white, white, white]);
    tri([0, 0, tailZ + 0.05], [tailHalf * 0.15, 0, tailZ - tailLength * 0.35], [tailHalf, 0, tailZ - tailLength], [white, white, white]);
  } else {
    tri([0, 0, tailZ + 0.05], [-tailHalf, 0, tailZ - tailLength], [tailHalf, 0, tailZ - tailLength], [white, white, white]);
  }

  // Wings: strips from the shoulder to the tip. The leading edge sweeps back at the carpal joint (the "hand").
  const shoulderY = species.radius * 0.25;
  for (const side of [-1, 1]) {
    for (let i = 0; i < wingSegments; i++) {
      const s0 = i / wingSegments;
      const s1 = (i + 1) / wingSegments;
      const edge = (s: number) => {
        const chord = species.chord * (1 - 0.7 * s);
        const hand = Math.max(0, s - 0.45) * species.sweep * species.span;
        const lead = species.length * 0.12 - s * 0.05 * species.span - hand;
        return { x: side * s * species.span, y: shoulderY + s * 0.04 * species.span, lead, trail: lead - chord };
      };
      const e0 = edge(s0), e1 = edge(s1);
      const tone = (s: number) => (s > 0.78 ? species.tip : species.back);
      const [t0, t1] = [tone(s0), tone(s1)];
      tri([e0.x, e0.y, e0.lead], [e0.x, e0.y, e0.trail], [e1.x, e1.y, e1.lead], [t0, t0, t1], [s0, s0, s1]);
      tri([e0.x, e0.y, e0.trail], [e1.x, e1.y, e1.trail], [e1.x, e1.y, e1.lead], [t0, t1, t1], [s0, s1, s1]);
    }
  }
  return b.geometry();
}

/** Triangle count of a built bird geometry. */
export function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.getAttribute('position').count / 3;
}

/** Shader additions: wings bend about the shoulder by an instanced phase, rate and glide bias. */
export function patchBirdShader(shader: { uniforms: Record<string, { value: unknown }>; vertexShader: string }, time: { value: number }, flap: { value: number }): void {
  shader.uniforms['uTime'] = time;
  shader.uniforms['uFlap'] = flap;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float wing;\nattribute vec3 aFlap;\nuniform float uTime;\nuniform float uFlap;')
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      // Birds glide in spells: aFlap.z is the share of the time the wings are held still.
      float spell = smoothstep(-0.2, 0.2, sin(uTime * 0.11 + aFlap.x * 2.7) - (1.0 - aFlap.z) * 1.6 + 0.8);
      float amp = mix(0.85, 0.1, spell) * uFlap;
      float beat = sin(uTime * aFlap.y + aFlap.x);
      // Raised wings in a glide, a full stroke when flapping; the tips lag the shoulder.
      transformed.y += (abs(position.x) * wing * (beat * amp * 0.55 + 0.12 * uFlap)) + wing * wing * beat * amp * 0.12;`,
    );
}
