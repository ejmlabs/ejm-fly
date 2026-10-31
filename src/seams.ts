import * as THREE from 'three';

/**
 * Contracts shared by the follow camera, the endless world, the underwater view
 * and the sound. World coordinates are fixed simulation metres; render
 * coordinates are world minus the floating origin, so drawing stays near (0, 0).
 */

/** Called after the floating origin moved by (dx, dz) world metres; render positions shift by (−dx, −dz). */
export type RecenterListener = (dx: number, dz: number) => void;

export interface FloatingOrigin {
  /** World X/Z of render (0, 0). */
  readonly x: number;
  readonly z: number;
  /** Returns an unsubscribe function. */
  onRecenter: (listener: RecenterListener) => () => void;
}

/** An origin that never moves: the start state, and the stand-in until the endless world is merged. */
export const FIXED_ORIGIN: FloatingOrigin = {
  x: 0,
  z: 0,
  onRecenter: () => () => {
    // It never recentres, so there is nothing to unsubscribe.
  },
};

/** What the follow camera tracks, in render coordinates. `heading` uses whaleForward's convention. */
export interface FollowTarget { x: number; y: number; z: number; heading: number }

/** Sea level (the water plane is flat; waves are only a normal map). */
export const WATER_LEVEL = 0;
/** Half-height of the band across the surface over which the view crossfades. */
export const SURFACE_BAND = 0.35;

export interface WaterSignal {
  /** Metres of water above the camera; negative above the surface. */
  depth: number;
  /** 0 fully above, 1 fully below, smooth across ±SURFACE_BAND. */
  submersion: number;
  underwater: boolean;
}

export function waterSignal(cameraY: number, out: WaterSignal = { depth: 0, submersion: 0, underwater: false }): WaterSignal {
  const depth = WATER_LEVEL - cameraY;
  const t = Math.min(1, Math.max(0, (depth + SURFACE_BAND) / (2 * SURFACE_BAND)));
  out.depth = depth;
  out.submersion = t * t * (3 - 2 * t);
  out.underwater = out.submersion > 0.5;
  return out;
}

/** Anything that sounds like a ship. ShipHandle satisfies it. */
export interface ShipEmitter { spec: { id: number; kind: 'sloop' | 'tall' }; group: THREE.Object3D }

/**
 * Underwater tint for materials without three's fog (the land). Only the
 * underwater view writes these; shaders spread them into their uniforms.
 */
export const underwaterUniforms = {
  underwaterMix: { value: 0 },
  underwaterColor: { value: new THREE.Color(0x0e4f5e) },
  underwaterDensity: { value: 0.045 },
};

export const UNDERWATER_GLSL_PARS = /* glsl */ `
uniform float underwaterMix;
uniform vec3 underwaterColor;
uniform float underwaterDensity;
vec3 applyUnderwater( vec3 color, float viewDistance ) {
  float a = underwaterMix * ( 1.0 - exp( -underwaterDensity * viewDistance ) );
  return mix( color, underwaterColor, clamp( a, 0.0, 1.0 ) );
}`;
