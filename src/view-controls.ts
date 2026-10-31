import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { clamp } from './math.js';
import { UNDER_MAX_DISTANCE, UNDER_ORBIT_PITCH, type FollowCamera, type ReviewView } from './camera.js';
import { LENGTH_SCALE } from './whale-size.js';
import { item } from './item.js';

/** Orbit distance from the whale, metres: clear of its body, never so far it is a speck. */
export const ORBIT_DISTANCE: readonly [number, number] = [10 * LENGTH_SCALE, 60 * LENGTH_SCALE];
/** Orbit pitch, radians: just above the horizon to about 75 degrees down. */
export const ORBIT_PITCH: readonly [number, number] = [0.02, 1.3];
const KEY_TURN = 0.12;
const KEY_ZOOM = 1.15;

export interface ViewControls {
  readonly orbiting: boolean;
  /** Reads the controls into the follow camera; call once a frame before it updates. */
  update: (reducedMotion: boolean) => void;
  /** Back to the default follow camera. */
  reset: () => void;
  dispose: () => void;
}

/**
 * Drag, touch, wheel, pinch and keys orbit and zoom around the whale. OrbitControls moves a proxy
 * camera in the whale's heading frame (azimuth 0 = behind it); the follow camera places the real eye
 * from that view, so its clearance, waterline and dive guards still apply.
 */
export function createViewControls(canvas: HTMLCanvasElement, rig: FollowCamera, onChange: (orbiting: boolean) => void): ViewControls {
  const proxy = new THREE.PerspectiveCamera();
  const controls = new OrbitControls(proxy, canvas);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.minDistance = ORBIT_DISTANCE[0];
  controls.maxDistance = ORBIT_DISTANCE[1];
  controls.minPolarAngle = Math.PI / 2 - ORBIT_PITCH[1];
  controls.maxPolarAngle = Math.PI / 2 - ORBIT_PITCH[0];
  let orbiting = false;

  const view = (): ReviewView => ({
    yaw: controls.getAzimuthalAngle(),
    pitch: Math.PI / 2 - controls.getPolarAngle(),
    distance: controls.getDistance(),
  });

  // The first input starts from where the eye is now, so the view does not jump.
  const engage = () => {
    if (orbiting) return;
    orbiting = true;
    const from = rig.view;
    const distance = clamp(from.distance, ORBIT_DISTANCE[0], ORBIT_DISTANCE[1]);
    proxy.position.setFromSphericalCoords(distance, Math.PI / 2 - clamp(from.pitch, ORBIT_PITCH[0], ORBIT_PITCH[1]), from.yaw);
    controls.update();
    rig.setOrbit(view());
    onChange(true);
  };
  controls.addEventListener('start', engage);

  const reset = () => {
    if (!orbiting) return;
    orbiting = false;
    rig.setOrbit(null);
    onChange(false);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const move: Record<string, () => void> = {
      ArrowLeft: () => { controls.rotateLeft(KEY_TURN); },
      ArrowRight: () => { controls.rotateLeft(-KEY_TURN); },
      ArrowUp: () => { controls.rotateUp(KEY_TURN); },
      ArrowDown: () => { controls.rotateUp(-KEY_TURN); },
      // OrbitControls' dollyOut moves the eye closer.
      '+': () => { controls.dollyOut(KEY_ZOOM); },
      '=': () => { controls.dollyOut(KEY_ZOOM); },
      '-': () => { controls.dollyIn(KEY_ZOOM); },
    };
    if (event.key === '0' || event.key === 'Home') reset();
    else if (move[event.key]) {
      engage();
      item(move, event.key)();
    } else return;
    event.preventDefault();
  };
  canvas.addEventListener('keydown', onKey);

  return {
    get orbiting() {
      return orbiting;
    },
    update(reducedMotion) {
      controls.enableDamping = !reducedMotion;
      // Under water the haze closes in and the whale can be seen from below: nearer, and down past the horizon.
      const under = rig.mode === 'under';
      controls.maxDistance = under ? Math.max(ORBIT_DISTANCE[0], UNDER_MAX_DISTANCE) : ORBIT_DISTANCE[1];
      controls.maxPolarAngle = Math.PI / 2 - (under ? UNDER_ORBIT_PITCH : ORBIT_PITCH[0]);
      controls.update();
      if (orbiting) rig.setOrbit(view());
    },
    reset,
    dispose() {
      canvas.removeEventListener('keydown', onKey);
      controls.dispose();
    },
  };
}
