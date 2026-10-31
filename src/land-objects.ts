import type { BufferGeometry } from 'three';
import { BoxGeometry, ConeGeometry, CylinderGeometry, ExtrudeGeometry, Float32BufferAttribute, IcosahedronGeometry, Matrix4, Quaternion, Shape, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Faceted low-poly shapes from three.js primitives: the trees, rocks and
 * houses baked into land tiles (in the tile worker) and the walkers' base
 * meshes. Every part is flat-shaded (unindexed, one normal per facet) and
 * carries a vertex colour and an optional tag.
 */

export type Rgb = readonly [number, number, number];

export interface Part {
  /** Colour at the top of the part, and (optionally) at its foot. */
  color: Rgb;
  foot?: Rgb;
  /** Offset of the part's centre. */
  at?: readonly [number, number, number];
  /** Turn about the vertical, in radians. */
  turn?: number;
  /** Per-axis stretch. */
  stretch?: readonly [number, number, number];
  /** Vertex tag for the walkers' moving parts. */
  tag?: number;
}

const up = new Vector3(0, 1, 0);
const matrix = new Matrix4();
const quaternion = new Quaternion();
const offset = new Vector3();
const scale = new Vector3();

/** One coloured, placed, flat-shaded part. Consumes `geometry`. */
export function part(geometry: BufferGeometry, { color, foot = color, at = [0, 0, 0], turn = 0, stretch = [1, 1, 1], tag = 0 }: Part): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  flat.deleteAttribute('uv');
  flat.applyMatrix4(matrix.compose(offset.set(...at), quaternion.setFromAxisAngle(up, turn), scale.set(...stretch)));
  flat.computeVertexNormals();
  flat.computeBoundingBox();
  const box = flat.boundingBox;
  if (!box) throw new Error('land object part has no bounds');
  const { min, max } = box;
  const position = flat.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  for (let v = 0; v < position.count; v++) {
    const t = max.y > min.y ? (position.getY(v) - min.y) / (max.y - min.y) : 1;
    for (let c = 0; c < 3; c++) colors[v * 3 + c] = (foot[c] ?? 0) + ((color[c] ?? 0) - (foot[c] ?? 0)) * t;
  }
  flat.setAttribute('color', new Float32BufferAttribute(colors, 3));
  flat.setAttribute('tag', new Float32BufferAttribute(new Float32Array(position.count).fill(tag), 1));
  return flat;
}

/** Parts merged into one geometry (position, normal, color, tag; unindexed). */
export function shape(parts: BufferGeometry[]): BufferGeometry {
  // three's types promise a geometry; it returns null when the parts' attributes differ.
  const merged = mergeGeometries(parts) as BufferGeometry | null;
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('land object parts do not match');
  return merged;
}

/** `prototype` stood at (x, y, z), turned by `yaw` and scaled by `size`: a new geometry. */
export function placed(prototype: BufferGeometry, x: number, y: number, z: number, yaw: number, size: number): BufferGeometry {
  return prototype.clone().applyMatrix4(matrix.compose(offset.set(x, y, z), quaternion.setFromAxisAngle(up, yaw), scale.set(size, size, size)));
}

/** A box `sx` by `sy` by `sz` standing on `y0`. */
export const box = (sx: number, sy: number, sz: number, y0: number, look: Omit<Part, 'at'> & { x?: number; z?: number }): BufferGeometry =>
  part(new BoxGeometry(sx, sy, sz), { ...look, at: [look.x ?? 0, y0 + sy / 2, look.z ?? 0] });

/** A cone (no base) of `sides` from `y0` up `height`. */
export const cone = (sides: number, radius: number, y0: number, height: number, look: Omit<Part, 'at'>, closed = false): BufferGeometry =>
  part(new ConeGeometry(radius, height, sides, 1, !closed), { ...look, at: [0, y0 + height / 2, 0] });

/** A tapering trunk (no caps). */
export const trunk = (sides: number, r0: number, r1: number, y0: number, y1: number, look: Omit<Part, 'at'>): BufferGeometry =>
  part(new CylinderGeometry(r1, r0, y1 - y0, sides, 1, true), { ...look, at: [0, (y0 + y1) / 2, 0] });

/** A rounded faceted lump of `radius` from `y0` up `height`. */
export const lump = (radius: number, y0: number, height: number, look: Omit<Part, 'at' | 'stretch'>): BufferGeometry =>
  part(new IcosahedronGeometry(1), { ...look, at: [0, y0 + height / 2, 0], stretch: [radius, height / 2, radius] });

/**
 * A house: walls from `y0` to the eaves at `height`, and a gable roof with its ridge along x, overhanging by
 * `eave`; or a tower with a pyramid roof.
 */
export function house(width: number, depth: number, height: number, y0: number, wall: Rgb, roof: Rgb, tower: boolean): BufferGeometry {
  const walls = box(width, height - y0, depth, y0, { color: wall });
  if (tower) return shape([walls, part(new ConeGeometry(width * 0.78, 4.5, 4), { color: roof, at: [0, height + 2.25, 0], turn: Math.PI / 4 })]);
  const eave = 0.45;
  const rise = 2.2 + depth * 0.12;
  const thick = 0.3;
  const half = depth / 2 + eave;
  // Gable ends in the wall colour, and the roof as a thick chevron over them.
  const gable = new Shape().moveTo(-depth / 2, 0).lineTo(depth / 2, 0).lineTo(0, rise).closePath();
  const ends = new ExtrudeGeometry(gable, { depth: width, bevelEnabled: false });
  ends.translate(0, 0, -width / 2);
  const chevron = new Shape().moveTo(-half, -eave * 0.5).lineTo(0, rise).lineTo(half, -eave * 0.5).lineTo(half - thick, -eave * 0.5).lineTo(0, rise - thick * 1.4).lineTo(-half + thick, -eave * 0.5).closePath();
  const slabs = new ExtrudeGeometry(chevron, { depth: width + eave * 2, bevelEnabled: false });
  slabs.translate(0, 0, -width / 2 - eave);
  return shape([
    walls,
    part(ends, { color: wall, at: [0, height, 0], turn: Math.PI / 2 }),
    part(slabs, { color: roof, at: [0, height, 0], turn: Math.PI / 2 }),
  ]);
}
