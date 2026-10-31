import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { makeNoise4D, fbm4 } from './noise.js';
import { hash } from './rng.js';
import type { ShelfMap } from './land.js';
import { SEA_WAVES, SWELL_WAVES, WIND_WAVES, packWaves, seaLevel } from './swell.js';
import { radianceFor } from './tone.js';
import { patchShader, type ShaderPatch } from './shader-patch.js';
import { GLSL_TILED_NOISE } from './underwater-glsl.js';
import { item } from './item.js';

/** Reflected land sits a touch darker than the land itself. */
const REFLECTION_GAIN = 0.85;
/** Sun glitter in scene light at a clear noon: the sparkle of single facets, and the sheen of the path they make. */
const GLITTER = 70;
const SHEEN = 1.6;
/** The foam's lattice, in the wind's frame, repeats every this many metres (a power of two, so every octave tiles). */
export const FOAM_PERIOD = 1024;
/** Foam drifts downwind at half the speed of the long roller: crests run on through it and leave it behind them. */
export const FOAM_DRIFT = 0.5 * item(WIND_WAVES, 0).speed;
/** Where the long roller, which runs downwind, sits among the packed waves. */
const ROLLER = SWELL_WAVES.length * 4;

export interface OceanHandle {
  water: Water;
  mesh: THREE.Mesh;
  /** With a camera, the plane follows it (render space) while ripples stay fixed to the world. */
  update: (dt: number, sunDirection: THREE.Vector3, camera?: THREE.Camera) => void;
  /** The water's base colour (a region's look). */
  setWaterColor: (color: THREE.Color) => void;
  /**
   * The light of the day: the haze colour (display) that lifts dark reflections, at the output's exposure; brightness
   * (0 dark to 1 day) of the water and of the shallows; and the sun's own strength (0 hidden to 1 clear), which
   * sets its glitter.
   */
  setSky: (sky: { haze: THREE.Color; exposure: number; light: number; shallowLight: number; sun: number }) => void;
  /** World X/Z of render (0, 0); keeps ripples and shelf maps on the world after a recentre. */
  setOrigin: (x: number, z: number) => void;
  /** Swaps in shelf maps baked elsewhere in the world (maps are in world coordinates). */
  setShelves: (shelves: { near?: ShelfMap; far?: ShelfMap }) => void;
  /** The whale's body origin in render coordinates, drawn as a soft silhouette under the surface. */
  setWhale: (x: number, y: number, z: number, heading: number) => void;
  /** The sea for this frame: the shared swell at its clock (world origin applied), the wind (0 to 1) and the camera's height, which the waves never reach. */
  setSea: (clock: number, wind: number, eyeY: number) => void;
  /** The swell as the water draws it, packed by `packWaves`; shared with what rides the crests. */
  waves: Float32Array;
  dispose: () => void;
}

/** Seamless tiling normals via 4D simplex on a torus; heights first, then wrapped central differences. */
function buildWaterNormals(seed: number, size = 256): THREE.DataTexture {
  const base = makeNoise4D(hash(seed, 'water-normals'), 0);
  const detail = makeNoise4D(hash(seed, 'water-detail'), 1);
  const heights = new Float32Array(size * size);
  const twoPi = Math.PI * 2;
  const R = 1.5;
  const Rd = 3.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const nx = Math.cos(u * twoPi) * R;
      const ny = Math.sin(u * twoPi) * R;
      const nz = Math.cos(v * twoPi) * R;
      const nw = Math.sin(v * twoPi) * R;
      const dx = Math.cos(u * twoPi) * Rd;
      const dy = Math.sin(u * twoPi) * Rd;
      const dz = Math.cos(v * twoPi) * Rd;
      const dw = Math.sin(v * twoPi) * Rd;
      const h =
        fbm4(base, nx, ny, nz, nw, 5) * 0.72 +
        fbm4(detail, dx, dy, dz, dw, 4) * 0.28;
      heights[y * size + x] = h;
    }
  }

  const data = new Uint8Array(size * size * 4);
  const slope = 1.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = heights[y * size + ((x - 1 + size) % size)] ?? 0;
      const hR = heights[y * size + ((x + 1) % size)] ?? 0;
      const hD = heights[((y - 1 + size) % size) * size + x] ?? 0;
      const hU = heights[((y + 1) % size) * size + x] ?? 0;
      let nx = (hL - hR) * slope;
      let ny = (hD - hU) * slope;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      data[i] = Math.floor((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

export function createOcean(
  seed: number,
  sunDirection: THREE.Vector3,
  options: {
    textureSize?: number;
    waterColor?: number;
    shelves?: { near: ShelfMap; far: ShelfMap; light?: number };
  } = {},
): OceanHandle {
  const textureSize = options.textureSize ?? 256;
  const normalSize = textureSize >= 512 ? 512 : 256;
  const normals = buildWaterNormals(seed, normalSize);

  const geometry = seaGeometry(textureSize >= 512 ? 192 : 160, textureSize >= 512 ? 150 : 130, 10000);
  const water = new Water(geometry, {
    textureWidth: textureSize,
    textureHeight: textureSize,
    waterNormals: normals,
    sunDirection: sunDirection.clone(),
    sunColor: 0xd4c8a8,
    waterColor: options.waterColor ?? 0x163e54,
    distortionScale: 2.6,
    fog: true,
    alpha: 1,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0;

  const material = water.material;
  // three's own water uniforms, replaced by typed objects this module keeps. Slightly muted water so the far plane
  // fades into fog without a bright seam.
  const base = {
    size: { value: 1.2 },
    distortionScale: { value: 4.2 },
    waterColor: { value: new THREE.Color(0x1a4e68) },
    alpha: { value: 1 },
    sunColor: { value: new THREE.Color(0xe8dcc0) },
    sunDirection: { value: sunDirection.clone() },
    time: { value: 0 },
  };
  Object.assign(material.uniforms, base);

  const look = applyWaterLook(material, options.shelves);
  const waves = new Float32Array(SEA_WAVES * 4);
  const sea = applySea(material, typeof geometry.userData['growth'] === 'number' ? geometry.userData['growth'] : 0, waves);
  const maps = { near: options.shelves?.near, far: options.shelves?.far };
  const origin = { x: 0, z: 0 };
  let light = 1;
  let foamClock = 0;

  /** Lays the foam's lattice on the world: the origin and the drift, reduced to the period in float64 like the ripples. */
  function anchorFoam(): void {
    if (!sea) return;
    const wind = sea.foamWind.value;
    const wrap = (v: number) => v - Math.floor(v / FOAM_PERIOD) * FOAM_PERIOD;
    sea.foamShift.value.set(wrap(wind.x * origin.x + wind.y * origin.z - FOAM_DRIFT * foamClock), wrap(wind.x * origin.z - wind.y * origin.x));
  }

  function place(): void {
    anchorFoam();
    if (!look) return;
    // Ripple texture offsets for the origin, reduced to their period in float64 so the GPU never sees large numbers.
    const fract = (v: number) => v - Math.floor(v);
    const ox = origin.x * base.size.value;
    const oz = origin.z * base.size.value;
    look.rippleShiftA.value.set(fract(ox / 103), fract(oz / 103), fract(ox / 107), fract(oz / 107));
    look.rippleShiftB.value.set(fract(ox / 8907), fract(oz / 9803), fract(ox / 1091), fract(oz / 1027));
    if (!look.shelf) return;
    if (maps.near) look.shelf.shelfNearBounds.value.copy(shelfBounds(maps.near, origin));
    if (maps.far) look.shelf.shelfFarBounds.value.copy(shelfBounds(maps.far, origin));
  }
  place();

  let time = 0;
  return {
    water,
    mesh: water,
    waves,
    update(dt: number, sun: THREE.Vector3, camera?: THREE.Camera) {
      time += dt;
      base.time.value = time * 0.35;
      base.sunDirection.value.copy(sun).normalize();
      if (camera) {
        water.position.x = camera.position.x;
        water.position.z = camera.position.z;
      }
    },
    setSea(clock: number, wind: number, eyeY: number) {
      if (!sea) return;
      packWaves(origin.x, origin.z, clock, waves);
      const level = seaLevel();
      sea.seaLevel.value = level;
      sea.seaEye.value = eyeY;
      sea.seaChop.value = 0.8 * level;
      let top = 0;
      for (let i = 0; i < SEA_WAVES; i++) top += waves[i * 4 + 2] ?? 0;
      sea.seaTop.value = top;
      // Wind roughens the ripples and streaks the reflections.
      sea.rippleGain.value = 1.5 + 1.6 * wind;
      base.distortionScale.value = 4.2 + 3.5 * wind;
      sea.foamLight.value = light;
      // The long roller runs downwind, and foam drifts with it.
      sea.foamWind.value.set(waves[ROLLER] ?? 1, waves[ROLLER + 1] ?? 0).normalize();
      foamClock = clock;
      anchorFoam();
    },
    setWhale(x: number, y: number, z: number, heading: number) {
      look?.whaleBody.value.set(x, z, heading, y);
    },
    setWaterColor(color: THREE.Color) {
      base.waterColor.value.copy(color).multiplyScalar(light);
    },
    setSky(sky) {
      light = sky.light;
      if (look) radianceFor(sky.haze, sky.exposure, look.reflectionHaze.value);
      if (look?.shelf) look.shelf.shallowLight.value = (options.shelves?.light ?? 1) * sky.shallowLight;
      base.sunColor.value.set(0xe8dcc0).multiplyScalar(sky.light);
      if (sea) sea.glitter.value = sky.sun;
    },
    setOrigin(x: number, z: number) {
      origin.x = x;
      origin.z = z;
      place();
    },
    setShelves(next: { near?: ShelfMap; far?: ShelfMap }) {
      const shelf = look?.shelf;
      if (!shelf) return;
      if (next.near) {
        shelf.shelfNear.value.dispose();
        shelf.shelfNear.value = shelfTexture(next.near);
        maps.near = next.near;
      }
      if (next.far) {
        shelf.shelfFar.value.dispose();
        shelf.shelfFar.value = shelfTexture(next.far);
        maps.far = next.far;
      }
      place();
    },
    dispose() {
      geometry.dispose();
      normals.dispose();
      look?.shelf?.shelfNear.value.dispose();
      look?.shelf?.shelfFar.value.dispose();
      material.dispose();
      // three's water keeps its mirror target to itself; its texture is reachable through the sampler.
      const mirror: unknown = material.uniforms['mirrorSampler']?.value;
      if (mirror instanceof THREE.Texture) mirror.dispose();
    },
  };
}

function shelfTexture(shelf: ShelfMap): THREE.DataTexture {
  const texture = new THREE.DataTexture(shelf.data, shelf.size, shelf.size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Maps render XZ onto a world-coordinate shelf map's texel centres. */
export function shelfBounds(shelf: ShelfMap, origin: { x: number; z: number }): THREE.Vector4 {
  const texel = shelf.extent / (shelf.size - 1);
  const span = texel * shelf.size;
  return new THREE.Vector4(shelf.min - texel * 0.5 - origin.x, (shelf.minZ ?? shelf.min) - texel * 0.5 - origin.z, 1 / span, 1 / span);
}

/**
 * The water's plane as rings around the camera, decimetres apart at the eye and widening by `growth` of their radius
 * out to `radius`, so waves near the camera are drawn finely and the far plane costs little. Local XY, as a plane.
 */
export function seaGeometry(segments: number, rings: number, radius: number): THREE.BufferGeometry {
  const first = 0.6;
  const growth = Math.exp(Math.log(1 + radius / first) / rings);
  const positions = new Float32Array((rings + 1) * (segments + 1) * 3);
  const uvs = new Float32Array((rings + 1) * (segments + 1) * 2);
  for (let i = 0; i <= rings; i++) {
    const r = first * (growth ** i - 1);
    for (let j = 0; j <= segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const v = i * (segments + 1) + j;
      positions.set([Math.cos(a) * r, Math.sin(a) * r, 0], v * 3);
      uvs.set([0.5 + (Math.cos(a) * r) / (2 * radius), 0.5 + (Math.sin(a) * r) / (2 * radius)], v * 2);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j;
      const b = a + segments + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(positions.length).map((_, k) => (k % 3 === 2 ? 1 : 0)), 3));
  geometry.setIndex(index);
  geometry.userData['growth'] = growth - 1;
  return geometry;
}

/** The shared swell in GLSL: `seaWaves` as packed by `packWaves`. Height, and slope with short waves faded by distance. */
export const SEA_GLSL = `
  uniform vec4 seaWaves[ ${String(SEA_WAVES)} ];
  float seaHeight( vec2 p, float dist, float near ) {
    float h = 0.0;
    for ( int i = 0; i < ${String(SEA_WAVES)}; i++ ) {
      vec4 w = seaWaves[ i ];
      float lambda = 6.2832 / length( w.xy );
      h += w.z * sin( dot( p, w.xy ) + w.w ) * ( 1.0 - smoothstep( lambda * near, lambda * near * 2.0, dist ) );
    }
    return h;
  }
  vec3 seaSlope( vec2 p, float dist ) {
    vec3 s = vec3( 0.0 );
    for ( int i = 0; i < ${String(SEA_WAVES)}; i++ ) {
      vec4 w = seaWaves[ i ];
      if ( w.z == 0.0 ) continue;
      float phase = dot( p, w.xy ) + w.w;
      float lambda = 6.2832 / length( w.xy );
      s.xy += w.z * cos( phase ) * w.xy * ( 1.0 - smoothstep( lambda * 8.0, lambda * 40.0, dist ) );
      s.z += w.z * sin( phase );
    }
    return s;
  }
`;

/**
 * Foam texture at a point of the foam's lattice (the wind's frame, metres), seen through a pixel `reach` metres across
 * and along the wind: octaves of value noise from 32 m across the wind down to 0.25 m, streaked downwind at the larger
 * scales and bent by a slow warp so the streaks wander. An octave fades out once a pixel spans it and the rest are
 * rescaled to keep their contrast, so distance thins the foam to its coarse patches and streaks instead of averaging it
 * into a smooth sheet. Returns the texture (mean 0, spread near 1), the same for its octaves of 8 m and under, which
 * breaks up a patch however coarse the rest is, and how much of the spread a pixel can still resolve (0 to about 0.9).
 * `foamGusts` is the wind's wider patchiness, mean 0 and within about 0.5, which stays whatever the pixel spans: swell
 * faces seen edge on have no texture to resolve, yet must not read as one flat grey.
 */
const FOAM_GLSL = `
  ${GLSL_TILED_NOISE}
  vec3 foamTexture( vec2 at, vec2 reach ) {
    vec2 bend = vec2( 128.0, 32.0 );
    at += 10.0 * ( vec2( tiledNoise( at / bend + 1.7, ${FOAM_PERIOD.toFixed(1)} / bend ), tiledNoise( at / bend.yx + 8.1, ${FOAM_PERIOD.toFixed(1)} / bend.yx ) ) - 0.5 );
    vec2 sum = vec2( 0.0 );
    vec2 variance = vec2( 0.0 );
    float cell = 32.0;
    float gain = 1.0;
    for ( int i = 0; i < 8; i++ ) {
      vec2 size = cell * vec2( cell > 3.0 ? 8.0 : ( cell > 1.5 ? 4.0 : ( cell > 0.9 ? 2.0 : 1.0 ) ), 1.0 );
      vec2 spanned = smoothstep( 0.5, 1.5, reach / size );
      float shown = gain * ( 1.0 - spanned.x ) * ( 1.0 - spanned.y );
      if ( shown > 0.0 ) {
        float octave = shown * ( tiledNoise( at / size + float( i ) * 7.31, ${FOAM_PERIOD.toFixed(1)} / size ) - 0.5 );
        vec2 part = vec2( 1.0, cell < 9.0 ? 1.0 : 0.0 );
        sum += part * octave;
        variance += part * shown * shown / 12.0;
      }
      cell *= 0.5;
      gain *= 0.9;
    }
    vec2 spread = inversesqrt( variance + 0.015 );
    return vec3( sum * spread, variance.x / ( variance.x + 0.015 ) );
  }
  float foamGusts( vec2 at ) {
    vec2 wide = vec2( 128.0, 32.0 );
    vec2 fine = vec2( 64.0, 16.0 );
    return 0.6 * tiledNoise( at / wide + 4.1, ${FOAM_PERIOD.toFixed(1)} / wide ) + 0.4 * tiledNoise( at / fine + 9.7, ${FOAM_PERIOD.toFixed(1)} / fine ) - 0.5;
  }
`;

/**
 * The swell on the water: the vertices rise with it while the rings are fine enough to draw a wave (each fades by its
 * wavelength), the ripples tilt with its slope out to the horizon, and rough crests break white.
 */
const seaVertexPatches: ShaderPatch[] = [
  { find: 'varying vec4 worldPosition;', replace: `varying vec4 worldPosition;
				uniform float seaEye;
				uniform float seaGrid;
				uniform float seaChop;
				uniform vec4 seaWaves[ ${String(SEA_WAVES)} ];` },
  {
    find: 'mirrorCoord = modelMatrix * vec4( position, 1.0 );',
    replace: `mirrorCoord = modelMatrix * vec4( position, 1.0 );
					{
						// Rings are dist * seaGrid apart: a wave is drawn while at least three of them span it. Rough water
						// also pinches crests and widens troughs, as wind waves do (the riders keep the plain height).
						float seaDist = length( mirrorCoord.xz - cameraPosition.xz );
						vec2 seaAt = mirrorCoord.xz;
						float seaH = 0.0;
						for ( int i = 0; i < ${String(SEA_WAVES)}; i++ ) {
							vec4 w = seaWaves[ i ];
							if ( w.z == 0.0 ) continue;
							float k = length( w.xy );
							float fade = 1.0 - smoothstep( 6.2832 / ( k * 6.0 * seaGrid ), 6.2832 / ( k * 3.0 * seaGrid ), seaDist );
							float phase = dot( seaAt, w.xy ) + w.w;
							seaH += w.z * sin( phase ) * fade;
							mirrorCoord.xz += seaChop * w.z * ( w.xy / k ) * cos( phase ) * fade;
						}
						// The water never rises into the lens.
						if ( seaEye > 0.0 ) seaH = min( seaH, seaEye - 0.4 );
						mirrorCoord.y += seaH;
					}`,
  },
  { find: 'vec4 mvPosition =  modelViewMatrix * vec4( position, 1.0 );', replace: 'vec4 mvPosition = viewMatrix * worldPosition;' },
];

const seaFragmentPatches: ShaderPatch[] = [
  {
    // Rough water breaks the mirror: reflections streak further and melt into the sky's haze.
    find: 'vec2 distortion = surfaceNormal.xz * ( 0.0016 + min( 1.3 / distance, 0.012 ) ) * distortionScale * vec2( 1.0, 1.7 );',
    replace: 'vec2 distortion = surfaceNormal.xz * ( 0.0016 + min( 1.3 / distance, 0.012 ) ) * distortionScale * vec2( 1.0, 1.7 ) * ( 1.0 + 2.0 * seaLevel );',
  },
  {
    find: 'reflectionSample = mix( reflectionSample, reflectionHaze, reflectionLift * reflectionDark );',
    replace: `reflectionSample = mix( reflectionSample, reflectionHaze, reflectionLift * reflectionDark );
      // Rough water mirrors a blur of the sky: swell faces turned toward the eye catch the higher, darker sky and faces
      // turned away the bright horizon, so each swell reads as light and shade instead of one flat grey. The eye mostly
      // sees faces turned toward it, so the tone pivots on their usual tilt (0.1) and the sea keeps its overall brightness.
      float roughSky = smoothstep( 0.15, 0.85, seaLevel );
      float facing = dot( -sea.xy, normalize( eyeDirection.xz ) );
      reflectionSample = mix( reflectionSample, reflectionHaze * mix( 1.0, clamp( 1.0 - 2.0 * ( facing - 0.1 ), 0.75, 1.35 ), roughSky ), 0.85 * roughSky );`,
  },
  { find: 'vec4 getNoise( vec2 uv ) {', replace: `uniform float rippleGain;
				uniform float seaLevel;
				uniform float foamLight;
				uniform float seaTop;
				uniform float glitter;
				uniform vec2 foamWind;
				uniform vec2 foamShift;
				${SEA_GLSL}
				${FOAM_GLSL}
				vec4 getNoise( vec2 uv ) {` },
  {
    find: 'vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );',
    replace: `vec3 surfaceNormal = normalize( noise.xzy * vec3( rippleGain, 1.0, rippleGain ) );
					float seaDist = length( worldPosition.xz - eye.xz );
					vec3 sea = seaSlope( worldPosition.xz, seaDist );
					surfaceNormal = normalize( vec3( surfaceNormal.x - sea.x, surfaceNormal.y, surfaceNormal.z - sea.y ) );`,
  },
  {
    find: 'vec3 outgoingLight = albedo;',
    replace: `{
        // Sun glitter: ripple facets that mirror the sun flash past the white point, a sheen gathers them into a path,
        // and the bloom carries both. Cloud over the sun and the night take it away.
        vec3 toSun = normalize( sunDirection + eyeDirection );
        float facet = max( 0.0, dot( surfaceNormal, toSun ) );
        float low = smoothstep( -0.02, 0.08, sunDirection.y );
        albedo += sunColor * glitter * low * ( ${GLITTER.toFixed(1)} * pow( facet, 1400.0 ) + ${SHEEN.toFixed(1)} * pow( facet, 160.0 ) );
      }
      vec3 outgoingLight = albedo;`,
  },
  {
    find: 'vec3 outgoingLight = albedo;',
    replace: `if ( seaLevel > 0.3 ) {
        // Whitecaps break on rough crests as lace and patches, streaked downwind. Their texture sits on a lattice fixed to
        // the world (foamShift), not on the ripples, which a distant pixel averages into a flat sheet.
        vec2 foamAt = vec2( dot( worldPosition.xz, foamWind ), dot( worldPosition.xz, vec2( -foamWind.y, foamWind.x ) ) ) + foamShift;
        // A pixel on a swell face seen edge on spans tens of metres: past a few metres more would only be averaged flat, so
        // the patches stay and shimmer instead, and the foam thins out with distance.
        vec3 grain = foamTexture( foamAt, min( fwidth( foamAt ), vec2( 4.0 ) ) );
        float lace = grain.x;
        float fine = grain.y;
        float rough = smoothstep( 0.3, 0.8, seaLevel );
        float resolved = smoothstep( 0.15, 0.6, grain.z ) * ( 1.0 - smoothstep( 300.0, 1000.0, seaDist ) );
        float edge = mix( 1.0, 0.35, rough );
        float caps = smoothstep( edge, edge + 0.6, 0.8 * sea.z / max( seaTop, 0.05 ) + 0.45 * lace + 0.4 * fine ) * rough * resolved;
        // A gale also thins foam out over the water between the caps.
        float film = 0.3 * smoothstep( 0.6, 1.0, seaLevel ) * smoothstep( -0.3, 0.9, lace ) * resolved;
        float foam = 1.0 - ( 1.0 - caps ) * ( 1.0 - film );
        // Thick foam is whiter than thin.
        vec3 foamColor = vec3( 0.78, 0.84, 0.86 ) * ( 0.12 + 0.88 * foamLight ) * ( 0.5 + 0.5 * smoothstep( -1.5, 2.0, fine ) );
        // Gusts roughen the water in patches, which lighten and darken what it mirrors.
        albedo *= 1.0 + 0.8 * reflectance * rough * foamGusts( foamAt );
        albedo = mix( albedo, foamColor, 0.85 * foam );
      }
      vec3 outgoingLight = albedo;`,
  },
];

/** Adds the swell to a (possibly already patched) Water material; all or nothing, as `applyWaterLook`. */
function applySea(material: THREE.ShaderMaterial, growth: number, waves: Float32Array) {
  const vertex = patchShader(material.vertexShader, seaVertexPatches);
  const fragment = patchShader(material.fragmentShader, seaFragmentPatches);
  if (vertex === null || fragment === null) {
    const message = 'ejm-calm: Water shader did not match the expected source; the water stays flat.';
    if (import.meta.env.DEV) throw new Error(message);
    console.warn(message);
    return null;
  }
  const sea = {
    seaWaves: { value: waves },
    seaLevel: { value: 0 },
    seaEye: { value: 0 },
    seaGrid: { value: growth },
    seaChop: { value: 0 },
    seaTop: { value: 0 },
    rippleGain: { value: 1.5 },
    foamLight: { value: 1 },
    glitter: { value: 1 },
    foamWind: { value: new THREE.Vector2(1, 0) },
    foamShift: { value: new THREE.Vector2() },
  };
  material.vertexShader = vertex;
  material.fragmentShader = fragment;
  Object.assign(material.uniforms, sea);
  material.needsUpdate = true;
  return sea;
}

/** Calm, slightly rough water: reflections streak and lift toward the haze instead of mirroring dark land. */
const reflectionPatches: ShaderPatch[] = [
  // Ripples are sampled in render space; these shifts carry the floating origin so they never jump.
  { find: 'vec2 uv0 = ( uv / 103.0 )', replace: 'vec2 uv0 = ( uv / 103.0 ) + rippleShiftA.xy' },
  { find: 'vec2 uv1 = uv / 107.0', replace: 'vec2 uv1 = uv / 107.0 + rippleShiftA.zw' },
  { find: 'vec2 uv2 = uv / vec2( 8907.0, 9803.0 )', replace: 'vec2 uv2 = uv / vec2( 8907.0, 9803.0 ) + rippleShiftB.xy' },
  { find: 'vec2 uv3 = uv / vec2( 1091.0, 1027.0 )', replace: 'vec2 uv3 = uv / vec2( 1091.0, 1027.0 ) + rippleShiftB.zw' },
  { find: 'vec4 getNoise( vec2 uv ) {', replace: `uniform vec4 rippleShiftA;
				uniform vec4 rippleShiftB;
				vec4 getNoise( vec2 uv ) {` },
  {
    find: 'uniform vec3 waterColor;',
    replace: `uniform vec3 waterColor;
      uniform vec3 reflectionHaze;
      uniform float reflectionLift;`,
  },
  {
    find: 'vec2 distortion = surfaceNormal.xz * ( 0.001 + 1.0 / distance ) * distortionScale;',
    // Stretch the ripple vertically on screen, as wind lanes do to real reflections.
    // Clamp the near term so close reflections (the whale) ripple instead of breaking up.
    replace: 'vec2 distortion = surfaceNormal.xz * ( 0.0016 + min( 1.3 / distance, 0.012 ) ) * distortionScale * vec2( 1.0, 1.7 );',
  },
  {
    find: 'vec3 reflectionSample = vec3( texture2D( mirrorSampler, mirrorCoord.xy / mirrorCoord.w + distortion ) );',
    replace: `vec3 reflectionSample = vec3( texture2D( mirrorSampler, mirrorCoord.xy / mirrorCoord.w + distortion ) );
      // Skylight scattered off the ripples lifts dark reflected land; bright sky stays as it is.
      float reflectionLuma = dot( reflectionSample, vec3( 0.2126, 0.7152, 0.0722 ) );
      float reflectionDark = 1.0 - smoothstep( 0.05, 0.6, reflectionLuma );
      reflectionSample *= mix( 1.0, ${REFLECTION_GAIN.toFixed(2)}, reflectionDark );
      reflectionSample = mix( reflectionSample, reflectionHaze, reflectionLift * reflectionDark );`,
  },
];

/**
 * The mirror-like surface hides anything below y = 0, so a whale cruising just
 * under it would vanish from the chase camera. Draw it through the water as a
 * soft, rippled, depth-faded silhouette, as a whale reads from a boat. Shape:
 * body origin with the head 6 m ahead and the tail stock 4.6 m behind
 * (whale-model), forward = whaleForward(heading).
 */
const whalePatches: ShaderPatch[] = [
  {
    find: 'uniform vec3 waterColor;',
    replace: `uniform vec3 waterColor;
      uniform vec4 whaleBody;`,
  },
  {
    find: 'vec3 outgoingLight = albedo;',
    replace: `{
        vec2 fwd = vec2( -cos( whaleBody.z ), sin( whaleBody.z ) );
        vec2 rel = worldPosition.xz - whaleBody.xy + surfaceNormal.xz * 0.6;
        float along = dot( rel, fwd );
        float across = abs( dot( rel, vec2( -fwd.y, fwd.x ) ) );
        float s = clamp( ( along + 4.6 ) / 10.6, 0.0, 1.0 );
        float halfWidth = 1.75 * sqrt( max( 0.0, sin( 3.14159 * ( 0.12 + 0.8 * s ) ) ) );
        float ends = smoothstep( -5.2, -4.2, along ) * ( 1.0 - smoothstep( 5.4, 6.2, along ) );
        float body = ( 1.0 - smoothstep( halfWidth * 0.55, halfWidth * 1.05, across ) ) * ends;
        float fluke = ( 1.0 - smoothstep( 0.8, 2.2, across ) ) * smoothstep( -6.6, -5.6, along ) * ( 1.0 - smoothstep( -5.2, -4.4, along ) );
        // Clearer near the surface, gone when deep or airborne; weaker at grazing angles where the mirror wins.
        float clear = exp( -max( 0.0, -whaleBody.w - 1.2 ) / 3.5 ) * ( 1.0 - smoothstep( -0.6, 0.4, whaleBody.w ) );
        float view = mix( 0.65, 1.0, smoothstep( 0.03, 0.3, eyeDirection.y ) );
        albedo = mix( albedo, albedo * 0.3 + waterColor * 0.15, max( body, fluke * 0.8 ) * clear * view * 0.85 );
      }
      vec3 outgoingLight = albedo;`,
  },
];

/**
 * Depth-based colour: turquoise over sandy shelves, teal over the slope,
 * open-ocean blue beyond. Texel centres map to world via min + uv * extent.
 */
function shelfPatches(): ShaderPatch[] {
  return [
    {
      find: 'uniform vec3 waterColor;',
      replace: `uniform vec3 waterColor;
      uniform sampler2D shelfNear;
      uniform sampler2D shelfFar;
      uniform vec4 shelfNearBounds;
      uniform vec4 shelfFarBounds;
      uniform vec3 shallowColor;
      uniform vec3 shelfColor;
      uniform float shallowLight;`,
    },
    {
      find: 'vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * waterColor;',
      replace: `vec2 nearUv = ( worldPosition.xz - shelfNearBounds.xy ) * shelfNearBounds.zw;
      vec2 farUv = ( worldPosition.xz - shelfFarBounds.xy ) * shelfFarBounds.zw;
      vec2 inside = step( vec2( 0.0 ), nearUv ) * step( nearUv, vec2( 1.0 ) );
      float shelf = mix( texture2D( shelfFar, farUv ).r, texture2D( shelfNear, nearUv ).r, inside.x * inside.y );
      // Wide, overlapping ramps: deep blue eases through teal into turquoise.
      float shallow = smoothstep( 0.4, 1.0, shelf );
      float slope = smoothstep( 0.15, 0.75, shelf );
      vec3 tint = mix( waterColor, shelfColor, slope );
      tint = mix( tint, shallowColor, shallow );
      vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * tint;`,
    },
    {
      find: 'vec3 outgoingLight = albedo;',
      replace: `// Light coming up through clear shallows, blended under the reflection (Fresnel):
      // strong where the view is steep, gone at grazing angles and with distance.
      // The camera sits a few metres up, so everything past ~100 m crowds into a thin band
      // above the horizon: keep a soft, capped grazing wash there so it never reads as a stripe.
      float steep = smoothstep( 0.004, 0.08, eyeDirection.y );
      float nearby = 1.0 - smoothstep( 150.0, 900.0, distance );
      float shelfMix = ( shallow * 0.9 + slope * 0.2 ) * steep * nearby * ( 1.0 - reflectance * 0.6 );
      // Light up through the shallows, in scene light so the turquoise survives the scene's low exposure.
      vec3 under = mix( shelfColor, shallowColor, shallow ) * shallowLight * 1.5;
      albedo = mix( albedo, under, clamp( shelfMix, 0.0, 0.8 ) );
      vec3 outgoingLight = albedo;`,
    },
  ];
}

/**
 * Patches three's Water shader with reflection lift and (optionally) shelf tints.
 * All or nothing: if any patch misses (a changed three.js), development builds
 * throw and production keeps the stock water with a warning.
 */
function applyWaterLook(
  material: THREE.ShaderMaterial,
  shelves: { near: ShelfMap; far: ShelfMap; light?: number } | undefined,
) {
  const patched = patchShader(material.fragmentShader, [...reflectionPatches, ...(shelves ? shelfPatches() : []), ...whalePatches]);
  if (patched === null) {
    const message = 'ejm-calm: Water shader did not match the expected source; using the stock water.';
    if (import.meta.env.DEV) throw new Error(message);
    console.warn(message);
    return null;
  }
  const look = {
    rippleShiftA: { value: new THREE.Vector4() },
    rippleShiftB: { value: new THREE.Vector4() },
    // Far below the floor until the first setWhale, so nothing shows.
    whaleBody: { value: new THREE.Vector4(0, 0, 0, -1e4) },
    // The haze in scene light, set with the sky each frame.
    reflectionHaze: { value: new THREE.Color() },
    reflectionLift: { value: 0.25 },
    shelf: shelves
      ? {
          shelfNear: { value: shelfTexture(shelves.near) },
          shelfFar: { value: shelfTexture(shelves.far) },
          shelfNearBounds: { value: shelfBounds(shelves.near, { x: 0, z: 0 }) },
          shelfFarBounds: { value: shelfBounds(shelves.far, { x: 0, z: 0 }) },
          shallowColor: { value: new THREE.Color(0x58aaa0) },
          shelfColor: { value: new THREE.Color(0x1d6f7c) },
          shallowLight: { value: shelves.light ?? 1 },
        }
      : null,
  };
  material.fragmentShader = patched;
  const { shelf, ...uniforms } = look;
  Object.assign(material.uniforms, uniforms, shelf);
  material.needsUpdate = true;
  return look;
}
