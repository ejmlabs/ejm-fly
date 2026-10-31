import * as THREE from 'three';

/**
 * A renderer for the sky outside a browser (tests and Node tools): the fields `createSky` reads, and nothing that
 * draws, so its environment refresh fails quietly as it would without WebGL.
 */
export function headlessRenderer(): THREE.WebGLRenderer {
  return { toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, getPixelRatio: () => 1 } as unknown as THREE.WebGLRenderer;
}
