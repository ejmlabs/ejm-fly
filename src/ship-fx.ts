import * as THREE from 'three';
import { smoothstep } from './math.js';
import { SHIP_SIZE, type ShipHandle } from './ships.js';
import { item } from './item.js';
import { drawAsAuthored } from './tone.js';

/** The most ships drawn at once (the stream's cap on `high`). */
export const SHIP_FX_CAPACITY = 8;
/** Foam sits just above the flat water. */
const LIFT = 0.05;

export interface ShipFx {
  /** Foam round each ship's hull and behind it (one draw), and its lanterns (one draw, at night only); in the ships' own space. */
  group: THREE.Group;
  /** `level` is the sky's brightness, 0 (night) to 1 (day). */
  update: (ships: readonly ShipHandle[], level: number) => void;
  /** Draws made last frame. */
  draws: () => number;
  dispose: () => void;
}

/** A square texture whose alpha is a soft ellipse or disc, made here rather than shipped. */
function softMap(size: number, power: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x - (size - 1) / 2) / (size / 2);
      const v = (y - (size - 1) / 2) / (size / 2);
      data.fill(Math.round(255 * Math.max(0, 1 - u * u - v * v) ** power), (y * size + x) * 4, (y * size + x) * 4 + 4);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Foam under every ship and a lantern at the masthead and stern: two draws for all of them. */
/** `surface` is the sea's height at world (x, z), which the foam lies on. */
export function createShipFx(surface: (x: number, z: number) => number = () => 0): ShipFx {
  const foamMap = softMap(32, 1.4);
  const lampMap = softMap(16, 2);
  const flat = new THREE.PlaneGeometry(1, 1);
  flat.rotateX(-Math.PI / 2);
  const foamMaterial = drawAsAuthored(new THREE.MeshBasicMaterial({ color: 0xffffff, alphaMap: foamMap, transparent: true, opacity: 0.5, depthWrite: false, fog: false }));
  const foam = new THREE.InstancedMesh(flat, foamMaterial, SHIP_FX_CAPACITY * 2);
  foam.frustumCulled = false;
  foam.renderOrder = 1;
  foam.count = 0;

  const lampPositions = new Float32Array(SHIP_FX_CAPACITY * 4 * 3);
  const lampGeometry = new THREE.BufferGeometry();
  lampGeometry.setAttribute('position', new THREE.BufferAttribute(lampPositions, 3).setUsage(THREE.DynamicDrawUsage));
  const lampMaterial = drawAsAuthored(new THREE.PointsMaterial({
    color: 0xffc878,
    size: 7,
    sizeAttenuation: false,
    alphaMap: lampMap,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  }));
  const lamps = new THREE.Points(lampGeometry, lampMaterial);
  lamps.frustumCulled = false;
  lamps.visible = false;
  const group = new THREE.Group();
  group.name = 'ship-fx';
  group.add(foam, lamps);

  const dummy = new THREE.Object3D();
  const lamp = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  let drawn = 0;
  return {
    group,
    update(ships, level) {
      const n = Math.min(ships.length, SHIP_FX_CAPACITY);
      foam.visible = n > 0;
      foam.count = n * 2;
      for (let i = 0; i < n; i++) {
        const ship = item(ships, i);
        const size = ship.spec.scale * SHIP_SIZE;
        const p = ship.group.position;
        // The ship's length lies along its own +X, turned by its heading.
        fwd.set(1, 0, 0).applyQuaternion(ship.group.quaternion);
        const heading = Math.atan2(-fwd.z, fwd.x);
        const length = ship.size.length * size;
        const beam = ship.size.beam * size;
        // A ring of foam at the waterline, and a longer, fainter tail behind.
        dummy.position.set(p.x, LIFT + surface(p.x, p.z), p.z);
        dummy.rotation.set(0, heading, 0);
        dummy.scale.set(length * 1.5, 1, beam * 2.6);
        dummy.updateMatrix();
        foam.setMatrixAt(i * 2, dummy.matrix);
        dummy.position.set(p.x - fwd.x * length * 1.1, 0, p.z - fwd.z * length * 1.1);
        dummy.position.y = LIFT + surface(dummy.position.x, dummy.position.z);
        dummy.scale.set(length * 2.2, 1, beam * 1.1);
        dummy.updateMatrix();
        foam.setMatrixAt(i * 2 + 1, dummy.matrix);
      }
      foam.instanceMatrix.needsUpdate = true;
      foamMaterial.color.setScalar(0.06 + 0.7 * level);

      // Lanterns come on as the light goes.
      const glow = 1 - smoothstep(0.15, 0.55, level);
      let count = 0;
      if (glow > 0.01) {
        for (let i = 0; i < n; i++) {
          const ship = item(ships, i);
          const size = ship.spec.scale * SHIP_SIZE;
          for (const local of ship.lanterns) {
            lamp.copy(local).multiplyScalar(size).applyQuaternion(ship.group.quaternion).add(ship.group.position);
            lampPositions.set([lamp.x, lamp.y, lamp.z], count * 3);
            count++;
          }
        }
      }
      lampGeometry.setDrawRange(0, count);
      item(lampGeometry.attributes, 'position').needsUpdate = true;
      lampMaterial.opacity = glow;
      lamps.visible = count > 0;
      drawn = (foam.visible ? 1 : 0) + (lamps.visible ? 1 : 0);
    },
    draws: () => drawn,
    dispose() {
      flat.dispose();
      foamMap.dispose();
      lampMap.dispose();
      foamMaterial.dispose();
      lampMaterial.dispose();
      lampGeometry.dispose();
      foam.dispose();
    },
  };
}
