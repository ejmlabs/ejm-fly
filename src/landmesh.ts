import * as THREE from 'three';
import type { Land } from './land.js';
import { makeNoise2D } from './noise.js';
import { chunkKey, parseChunkKey, cellDistance } from './chunks.js';
import { hash } from './rng.js';
import { buildTile, tileSize, TOP_LEVEL, SINK, type ShadingMaps, type TileData } from './world-tiles.js';
import { createLandLife, type LandLife } from './land-life.js';
import type { WorkerRequest } from './world-worker.js';
import { underwaterUniforms, UNDERWATER_GLSL_PARS } from './seams.js';
import { item } from './item.js';
import { trimOldest } from './bounded.js';
import { DRAW_AS_AUTHORED_GLSL, SCENE_FROM_DISPLAY_GLSL, displayExposure } from './tone.js';

export { biomeColor } from './world-tiles.js';

export interface LandStreamOptions {
  /** Old clipmap ring segments; tiles get 3/16 of that per side, and the worker's coarse tiles twice as many (`tileCells`). */
  segments: number;
  sunDirection: THREE.Vector3;
  /** Sky colour at the horizon; distance haze blends land into it. */
  hazeColor: THREE.Color;
  /** Haze density per metre (thicker at golden hour and dusk). */
  hazeDensity?: number;
  /** Sky colours by elevation angle; when set, haze matches the sky behind each point. */
  hazeGradient?: { angles: number[]; colors: THREE.Color[] };
  /** Build tiles in a worker (browser only); falls back to time-sliced main-thread builds. */
  worker?: boolean | undefined;
  /** Trees, rocks and houses a tile may carry (0 for bare land). */
  objects?: number;
  /** Fine bump detail: none, near the camera, or out to the middle distance. */
  microNormal?: 'off' | 'near' | 'full';
  /**
   * How a fading tile dissolves: by sample coverage on a multisampled target (a true cross-fade), or by a fine
   * screen-space dither where there is no multisampling.
   */
  dissolve?: Dissolve | undefined;
}

export type Dissolve = 'coverage' | 'dither';

/** A placed, wanted tile with people or animals on it. */
export interface WalkerTile { x0: number; z0: number; level: number; data: Float32Array }

export interface LandStream {
  /** Holds tiles at world positions: add it under the world root. */
  group: THREE.Group;
  /**
   * Builds every tile needed around world (x, z) right now, bare and fully faded in (first frame); the worker then
   * rebuilds them with their life and shading maps, which dissolve in over the bare land.
   */
  prime: (x: number, z: number) => void;
  /**
   * Streams around world (x, z) moving at (vx, vz) m/s and advances fades: finer
   * tiles lead along the motion, and tiles further ahead are built early and held.
   */
  update: (x: number, z: number, dt: number, vx?: number, vz?: number) => void;
  /** A tile's dissolve state, or undefined when it is not placed. */
  tileState: (key: string) => 'in' | 'on' | 'out' | undefined;
  /** The land's look in a region: haze density scaled, vertex colours multiplied. */
  setLook: (hazeDensity: number, tint: THREE.Color) => void;
  /**
   * The light of the day: sun direction and colour (its hue tints the lit slopes), haze colours (as many as at
   * creation), base haze density and brightness (0 dark to 1 day).
   */
  setSky: (sun: THREE.Vector3, sunColor: THREE.Color, haze: readonly THREE.Color[], density: number, light: number) => void;
  /** World X/Z of render (0, 0), so surface detail stays fixed to the ground across recentres. */
  setOrigin: (x: number, z: number) => void;
  /** Uniforms of the land's lighting and haze, for what stands on the land (see `landShadingGLSL`). */
  readonly uniforms: Record<string, THREE.IUniform>;
  /** The land's materials, solid and dissolving, to compile ahead of their first draw. */
  readonly materials: readonly THREE.Material[];
  readonly hazeStops: number;
  /** The walkers of the tiles drawn now, and a count that changes whenever that set may have. */
  walkerTiles: () => WalkerTile[];
  walkerVersion: () => number;
  stats: () => {
    tiles: number;
    triangles: number;
    /** Trees, rocks and houses in the wanted tiles drawn now, and their triangles. */
    objectTriangles: number;
    objects: number;
    pending: number;
    fading: number;
    /** Built ahead, not yet wanted. */
    ready: number;
    /** Wanted tiles inside the haze with nothing solid over them right now. */
    holes: number;
    /** Tiles that have finished dissolving in, ever. */
    completed: number;
  };
  dispose: () => void;
}

/** Sunlight on the land at a clear noon (sRGB), and its brightness: a low sun keeps that and takes its own hue. */
const SUN_TINT = 0xfff0d8;
const luma = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const SUN_TINT_LUMA = luma(new THREE.Color().setHex(SUN_TINT, THREE.SRGBColorSpace));
/** Eye height the haze gradient is measured from (the camera rides just above the sea). */
const EYE = 4;
/** Default haze density (per metre); land a few kilometres out melts into the sky. */
const HAZE = 0.00026;
/** Haze is complete here, inside the streamed radius, so the land never shows an edge. */
const HAZE_END = 7800;
/** Tiles are kept out to this distance from the camera. */
const STREAM_RADIUS = 8600;
/** A tile splits into four when the camera is closer than SPLIT × its size. */
const SPLIT = 0.8;
/** Seconds a tile takes to dissolve in or out (±20% per tile, so neighbours never finish in step). */
const FADE = 1.5;
/** Re-select tiles once the selection centre has moved this far. */
const RESELECT = 12;
/** Tiles are refined this many seconds of motion before the camera reaches them (capped in metres). */
const LEAD = 6;
const LEAD_MAX = 200;
/** Tiles this far ahead are built early and held ready (not drawn) until wanted. */
const PREFETCH = 12;
const PREFETCH_MAX = 600;
const READY_CAP = 96;
/** Built tiles start dissolving in at most this many per frame, so a burst of arrivals trickles in. */
const PLACE_PER_FRAME = 2;
/** Full builds of bare tiles replace them at most this many per frame (they add no tiles, only their detail). */
const UPGRADE_PER_FRAME = 6;

/** A shading map as a mipmapped texture (see `ShadingMaps`). */
function mapTexture(maps: ShadingMaps, data: Uint8Array, colorSpace: THREE.ColorSpace): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, maps.size, maps.size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = colorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Far ranges are seen at a grazing angle.
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Seeded per-tile value in [0, 1): order jitter and fade length. */
const tileUnit = (seed: number, level: number, ix: number, iz: number) => hash(seed, 0x544c, level, ix, iz) / 0x100000000;

/** (vx, vz)·seconds, capped at `max` metres. */
function ahead(vx: number, vz: number, seconds: number, max: number): [number, number] {
  const k = Math.min(seconds, max / Math.max(1e-6, Math.hypot(vx, vz)));
  return [vx * k, vz * k];
}

const vertexShader = /* glsl */ `
attribute vec4 detail;
varying vec2 vLocal;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec4 vDetail;
void main() {
  vColor = color;
  vNormal = normal;
  vDetail = detail;
  vLocal = position.xz;
  vec4 world = modelMatrix * vec4( position, 1.0 );
  // Far land settles into the sea toward the streamed edge (behind the haze), so no edge can show.
  float far = smoothstep( ${(HAZE_END - 1600).toFixed(1)}, ${HAZE_END.toFixed(1)}, length( world.xz - cameraPosition.xz ) );
  world.y = ( world.y + ${SINK.toFixed(2)} ) * ( 1.0 - far ) - ${SINK.toFixed(2)};
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

/**
 * Lighting and aerial perspective per fragment, shared by the land and what
 * stands on it, so tall far triangles haze evenly instead of streaking between
 * vertices. Haze runs by horizontal distance from the camera from a fixed eye
 * height, which keeps the land's colour identical in the water's mirror pass,
 * and is complete before the streamed edge.
 */
export function landShadingGLSL(stops: number): string {
  return /* glsl */ `
uniform vec3 sunDirection;
uniform vec3 sunTint;
uniform float hazeDensity;
uniform vec3 landTint;
uniform float landLight;
uniform float hazeAngles[${String(stops)}];
uniform vec3 hazeColors[${String(stops)}];
${UNDERWATER_GLSL_PARS}
${SCENE_FROM_DISPLAY_GLSL}

vec3 hazeAt( float deg ) {
  vec3 color = hazeColors[0];
  for ( int i = 1; i < ${String(stops)}; i++ ) {
    float t = clamp( ( deg - hazeAngles[i - 1] ) / max( 1e-3, hazeAngles[i] - hazeAngles[i - 1] ), 0.0, 1.0 );
    color = mix( color, hazeColors[i], t );
  }
  return color;
}

vec3 landShade( vec3 albedo, vec3 n, vec3 world ) {
  float lambert = max( 0.0, dot( n, sunDirection ) );
  // The sun models the land: a stronger key than the sky's fill, so slopes away from it fall into shade.
  float sky = 0.3 + 0.14 * n.y;
  // Shade takes the sky's own hue (blue by day, warm at sunset, moonlit at night) at the same brightness.
  vec3 zenith = hazeColors[${String(stops - 1)}];
  vec3 skyHue = min( zenith / max( 1e-4, dot( zenith, vec3( 0.2126, 0.7152, 0.0722 ) ) ), vec3( 1.6 ) );
  float h = world.y + ${SINK.toFixed(2)};
  float d = length( world.xz - cameraPosition.xz );
  // Far ranges read as solid masses: facet-to-facet light differences fade with distance.
  float distant = 0.25 * smoothstep( 2000.0, 5500.0, d );
  lambert = mix( lambert, 0.45 * max( 0.0, sunDirection.y ) + 0.25, distant );
  sky = mix( sky, 0.5, distant );
  vec3 lit = albedo * landTint * landLight * ( sky * mix( vec3( 1.0 ), skyHue, 0.3 ) + lambert * 0.92 * sunTint );
  // Air thins with altitude: high ridges and snowfields stay solid through the haze.
  float dh = d * mix( 1.0, 0.62, smoothstep( 150.0, 900.0, h ) );
  // Thin enough that ranges a few kilometres out keep their spurs and gullies.
  float a = min( 0.88, 1.0 - exp( -dh / 15000.0 - pow( dh * hazeDensity * 0.75, 2.0 ) ) );
  // Past the composed view the haze closes completely, well inside the streamed edge.
  a = max( a, smoothstep( ${(HAZE_END - 1600).toFixed(1)}, ${HAZE_END.toFixed(1)}, d ) );
  // Haze is the air in front of the peak (sky nearer the horizon), not the sky behind
  // it, so a far range stays a distinct silhouette rather than a see-through curtain.
  vec3 haze = hazeAt( 0.5 * degrees( atan( h - ${EYE.toFixed(1)}, max( 1.0, d ) ) ) );
  return applyUnderwater( mix( lit, haze, a ), length( world - cameraPosition ) );
}`;
}

/** Bump detail out to these distances by tier (0 for none). */
const BUMP_REACH = { off: 0, near: 700, full: 1600 } as const;

/**
 * The land itself: the shared shading over procedural surface detail that
 * costs no triangles (rock strata and grain, wet rock and sand at the
 * waterline, mottled grass, forest canopy, sand ripples, and a fine bump
 * normal), all faded out with distance. Objects baked into the tiles skip the
 * detail. Fading tiles dissolve by coverage or a screen-space dither (opaque either way, no sorting).
 */
function fragmentShader(stops: number, fading: Dissolve | null, bump: number): string {
  return /* glsl */ `
uniform float fade;
uniform vec2 origin;
uniform sampler2D colorMap;
uniform sampler2D normalMap;
// 1 / tile size with shading maps, else 0.
uniform float mapScale;
${landShadingGLSL(stops)}
varying vec2 vLocal;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec4 vDetail;

float hash12( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * 0.1031 );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}

float vnoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( hash12( i ), hash12( i + vec2( 1.0, 0.0 ) ), u.x ), mix( hash12( i + vec2( 0.0, 1.0 ) ), hash12( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}

// Metres one pixel spans here, and how much of a detail with this period (metres) can show without aliasing.
float footprint;
float shows( float period ) {
  return 1.0 - smoothstep( 0.2, 0.5, footprint / period );
}

// Noise of the given period, projected from the three axes and blended by the facing (triplanar), so steep faces
// are not smeared and no projection seams show.
float tri( vec3 p, vec3 w, float period ) {
  return w.x * vnoise( p.zy / period ) + w.y * vnoise( p.xz / period ) + w.z * vnoise( p.xy / period );
}

void main() {
  ${
    fading === 'dither'
      ? `// Interleaved gradient noise: an even, fine dissolve.
  float grain = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  if ( grain >= fade ) discard;`
      : ''
  }
  vec3 n = normalize( vNormal );
  vec3 albedo = vColor;
  // A coarse tile's maps hold the ground finer than its vertices: spurs and gullies, rock, snow lines (not objects).
  vec4 mapColor = texture2D( colorMap, vLocal * mapScale );
  vec4 mapNormal = texture2D( normalMap, vLocal * mapScale );
  if ( mapScale > 0.0 && vDetail.w < 0.5 ) {
    albedo = mapColor.rgb * ( 0.6 + 0.8 * mapNormal.a );
    n = normalize( mapNormal.xyz * 2.0 - 1.0 );
  }
  float d = length( vWorld.xz - cameraPosition.xz );
  float near = 1.0 - smoothstep( 900.0, 3800.0, d );
  ${bump ? `float reach = 1.0 - smoothstep( ${(bump * 0.3).toFixed(1)}, ${bump.toFixed(1)}, d );` : ''}
  // Derivatives before any branch, where they are defined for every pixel.
  footprint = length( fwidth( vWorld ) );
  // World position fixed to the ground, whatever the floating origin.
  vec3 p = vWorld + vec3( origin.x, 0.0, origin.y );
  // Rock detail belongs to rock: a slope only part way to a face stays grass.
  float rock = smoothstep( 0.35, 0.9, vDetail.x );
  vec3 w = pow( abs( n ), vec3( 4.0 ) );
  w /= w.x + w.y + w.z;
  // Detail height for the bump (metres), zero wherever no bump reaches, so its derivatives below are defined.
  float height = 0.0;
  float macro = 1.0 - smoothstep( 5000.0, 8000.0, d );
  if ( vDetail.w < 0.5 && macro > 0.0 ) {
    // Broad variation that carries to the far ranges: warm and cool drifts in the grass and the rock, and
    // rain streaks down rock faces (stretched down the slope, sampled from the two side axes).
    float drift = ( vnoise( p.xz / 240.0 ) - 0.5 ) * shows( 240.0 );
    albedo *= vec3( 1.0 + 0.16 * drift, 1.0 + 0.06 * drift, 1.0 - 0.1 * drift );
    float streaks = ( w.x * vnoise( vec2( p.z / 7.0, p.y / 55.0 ) ) + w.z * vnoise( vec2( p.x / 7.0, p.y / 55.0 ) ) ) / max( 0.05, w.x + w.z ) - 0.5;
    float stain = ( vnoise( p.xz / 90.0 + p.y / 140.0 ) - 0.5 ) * shows( 90.0 );
    albedo *= 1.0 + rock * macro * ( 0.34 * streaks * shows( 7.0 ) + 0.3 * stain );
  }
  if ( vDetail.w < 0.5 && near > 0.0 ) {
    float h = vWorld.y + ${SINK.toFixed(2)};
    float sand = vDetail.y;
    float forest = vDetail.z;
    float open = ( 1.0 - rock ) * ( 1.0 - sand );
    // Rock: strata about 7 m apart with finer bedding between, wandering with a broad warp, and grit.
    float warp = vnoise( p.xz / 70.0 ) * 9.0 + tri( p, w, 9.0 ) * 1.6;
    float strata = ( sin( ( p.y + warp ) * 0.9 ) * 0.5 + 0.5 ) * shows( 7.0 );
    float bedding = ( sin( ( p.y + warp * 0.4 ) * 3.7 ) * 0.5 ) * shows( 1.7 );
    float grit = ( tri( p, w, 1.7 ) - 0.5 ) * shows( 1.7 );
    float blocks = ( tri( p, w, 5.0 ) - 0.5 ) * shows( 5.0 );
    vec3 bands = mix( vec3( 0.93, 0.92, 0.9 ), vec3( 1.04, 1.02, 0.97 ), strata );
    albedo = mix( albedo, albedo * bands * ( 1.0 + 0.12 * bedding + 0.26 * grit + 0.18 * blocks ), rock * near );
    // Wet rock and sand along the waterline, ragged at its top.
    float wet = 1.0 - smoothstep( 0.2, 1.4 + 1.2 * vnoise( p.xz / 6.0 ), h );
    albedo *= 1.0 - 0.4 * wet * max( rock, sand ) * near;
    // Grass mottled at two scales; forest canopy as crowns and gaps; sand speckled and rippled.
    float mottle = ( vnoise( p.xz / 11.0 ) - 0.5 ) * shows( 11.0 );
    float tuft = ( vnoise( p.xz / 2.6 ) - 0.5 ) * shows( 2.6 );
    albedo *= 1.0 + ( 0.24 * mottle + 0.16 * tuft ) * open * ( 1.0 - forest ) * near;
    float crowns = ( vnoise( p.xz / 4.4 ) - 0.5 ) * shows( 4.4 );
    albedo *= 1.0 + 0.5 * crowns * forest * near;
    float ripple = sin( dot( p.xz, vec2( 0.83, 0.55 ) ) * 2.4 + vnoise( p.xz / 5.0 ) * 3.0 ) * 0.5 * shows( 2.6 );
    albedo *= 1.0 + ( 0.1 * grit + 0.05 * ripple ) * sand * near;
    ${
      bump
        ? `height = ( rock * ( strata * 0.9 + bedding * 0.6 + grit * 0.7 + blocks * 1.2 ) + forest * crowns * 1.4 + open * ( 1.0 - forest ) * tuft * 0.3 ) * reach;`
        : ''
    }
  }
  ${
    bump
      ? `// Bump from screen-space derivatives of the detail height, taken outside every branch.
  vec3 dx = dFdx( vWorld );
  vec3 dy = dFdy( vWorld );
  float hx = dFdx( height );
  float hy = dFdy( height );
  if ( reach > 0.0 ) {
    vec3 r1 = cross( dy, n );
    vec3 r2 = cross( n, dx );
    float det = dot( dx, r1 );
    vec3 grad = sign( det ) * ( hx * r1 + hy * r2 );
    // Seen near edge-on (or where the derivatives lose precision) det goes to zero: the gradient would swamp the
    // normal or both would vanish, a NaN or back-facing normal that shades black. Tilt at most about 60 degrees,
    // and keep the plain normal where the bumped one collapses.
    float scale = abs( det );
    float steep = length( grad );
    if ( steep > scale * 1.7 ) grad *= scale * 1.7 / steep;
    vec3 bumped = scale * n - grad;
    if ( dot( bumped, bumped ) > 1e-12 ) n = normalize( bumped );
  }`
      : ''
  }
  // With coverage, alpha is the share of each pixel's samples the tile covers.
  gl_FragColor = vec4( landShade( albedo, n, vWorld ), ${fading === 'coverage' ? 'fade' : '1.0'} );
  ${DRAW_AS_AUTHORED_GLSL}
}`;
}

interface Tile {
  key: string;
  level: number;
  ix: number;
  iz: number;
  mesh: THREE.Mesh | null;
  /** Built bare on the main thread at the start; waiting for the worker's full build. */
  bare: boolean;
  /** The bare mesh under a full one dissolving in over it, that dissolve (0 → 1), and when it began (ms). */
  under: THREE.Mesh | null;
  rise: number;
  riseStart: number;
  triangles: number;
  objectTriangles: number;
  objects: number;
  walkers: Float32Array | null;
  /** 0 → 1 while dissolving in; back to 0 while dissolving out. */
  fade: number;
  /** Seconds this tile's dissolve takes. */
  fadeTime: number;
  state: 'in' | 'on' | 'out';
}

/**
 * Picks the tiles to draw around (x, z): a quadtree from TOP_LEVEL down, where a
 * node splits when the camera is within SPLIT × its size. Nodes that were split
 * stay split a little longer, so a camera hovering at a boundary never flickers.
 * With a lead (ax, az), distance is measured to the segment from the camera to
 * the camera + lead, so the tiles it is heading into are refined early.
 */
export function selectTiles(
  x: number,
  z: number,
  wasSplit: ReadonlySet<string>,
  split: Set<string>,
  radius = STREAM_RADIUS,
  factor = SPLIT,
  ax = 0,
  az = 0,
): string[] {
  const out: { key: string; d: number; level: number }[] = [];
  const top = tileSize(TOP_LEVEL);
  // Samples along the segment, at most 16 m apart (a cell's distance is convex along it).
  const samples = Math.ceil(Math.hypot(ax, az) / 16);
  const distance = (ix: number, iz: number, size: number) => {
    let d = cellDistance(x, z, ix, iz, size);
    for (let k = 1; k <= samples; k++) d = Math.min(d, cellDistance(x + (ax * k) / samples, z + (az * k) / samples, ix, iz, size));
    return d;
  };
  const visit = (level: number, ix: number, iz: number) => {
    const size = tileSize(level);
    const d = distance(ix, iz, size);
    const key = chunkKey(level, ix, iz);
    const reach = factor * size * (wasSplit.has(key) ? 1.2 : 1);
    if (level > 0 && d < reach) {
      split.add(key);
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) visit(level - 1, ix * 2 + i, iz * 2 + j);
    } else {
      out.push({ key, d, level });
    }
  };
  for (let iz = Math.floor((z - radius) / top); iz <= Math.floor((z + radius) / top); iz++) {
    for (let ix = Math.floor((x - radius) / top); ix <= Math.floor((x + radius) / top); ix++) {
      if (cellDistance(x, z, ix, iz, top) <= radius) visit(TOP_LEVEL, ix, iz);
    }
  }
  out.sort((a, b) => a.d - b.d || a.level - b.level || (a.key < b.key ? -1 : 1));
  return out.map((t) => t.key);
}

interface Cell { level: number; ix: number; iz: number }

function overlaps(a: Cell, b: Cell): boolean {
  const sa = tileSize(a.level);
  const sb = tileSize(b.level);
  return a.ix * sa < (b.ix + 1) * sb && b.ix * sb < (a.ix + 1) * sa && a.iz * sa < (b.iz + 1) * sb && b.iz * sb < (a.iz + 1) * sa;
}

/**
 * Endless land: LOD tiles streamed around the camera, built in a worker, each
 * dissolving in over FADE seconds; a tile being replaced stays until everything
 * covering it is solid, then dissolves out.
 */
export function createLandStream(land: Land, options: LandStreamOptions): LandStream {
  const cells = Math.max(8, Math.round((options.segments * 3) / 16));
  const sun = options.sunDirection.clone().normalize();
  const sunTint = new THREE.Color().setHex(SUN_TINT, THREE.SRGBColorSpace);
  const patchNoise = makeNoise2D(land.seed, 21);
  const objects = options.objects ?? 0;
  // Main-thread builds after the first frame (no worker) place life from their own copy of the rules, made when first needed.
  let life: LandLife | null = null;
  let walkerVersion = 0;
  // Without a gradient, a single haze colour at every elevation.
  const gradient = options.hazeGradient ?? { angles: [0, 90], colors: [options.hazeColor, options.hazeColor] };
  let baseDensity = options.hazeDensity ?? HAZE;
  let look = 1;
  const uniforms = {
    sunDirection: { value: sun },
    sunTint: { value: sunTint },
    hazeDensity: { value: options.hazeDensity ?? HAZE },
    landTint: { value: new THREE.Color(1, 1, 1) },
    landLight: { value: 1 },
    hazeAngles: { value: gradient.angles.slice() },
    hazeColors: { value: gradient.colors.map((c) => c.clone()) },
    fade: { value: 1 },
    origin: { value: new THREE.Vector2() },
    colorMap: { value: null as THREE.Texture | null },
    normalMap: { value: null as THREE.Texture | null },
    mapScale: { value: 0 },
    displayExposure,
    ...underwaterUniforms,
  };
  const bump = BUMP_REACH[options.microNormal ?? 'off'];
  const makeMaterial = (fading: Dissolve | null) =>
    new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: fragmentShader(gradient.angles.length, fading, bump),
      uniforms,
      vertexColors: true,
      fog: false,
      alphaToCoverage: fading === 'coverage',
    });
  const solid = makeMaterial(null);
  const dissolving = makeMaterial(options.dissolve ?? 'dither');

  const group = new THREE.Group();
  group.name = 'land';
  const tiles = new Map<string, Tile>();
  const requested = new Set<string>();
  /** The colour map of the last land draw's uniforms (undefined for none). */
  let bound: THREE.Texture | undefined;
  /** Bare tiles from the first frame, nearest first, still to be rebuilt in full. */
  let bare: string[] = [];
  let wanted = new Set<string>();
  let wantedList: string[] = [];
  let wantedCells: { key: string; level: number; ix: number; iz: number }[] = [];
  let split = new Set<string>();
  let lastX = Infinity;
  let lastZ = Infinity;
  let lastAX = 0;
  let lastAZ = 0;
  let queue: string[] = [];
  /** Built tiles waiting to be placed (paced), and tiles built ahead of need. */
  const arrived: { key: string; data: TileData | null }[] = [];
  const ready = new Map<string, TileData | null>();
  let completed = 0;
  let holes = 0;

  let worker: Worker | null = null;
  let inFlight = 0;
  const MAX_IN_FLIGHT = 2;
  if (options.worker && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./world-worker.ts', import.meta.url), { type: 'module' });
      const init: WorkerRequest = { type: 'init', seed: land.seed, viewYaw: land.viewYaw, offset: land.offset };
      worker.postMessage(init);
      worker.onmessage = (event: MessageEvent<{ type: string; key: string; data: TileData | null }>) => {
        if (event.data.type !== 'tile') return;
        inFlight = Math.max(0, inFlight - 1);
        requested.delete(event.data.key);
        received(event.data.key, event.data.data);
        // Keep the worker busy between frames, however slow they are.
        send();
      };
      worker.onerror = () => {
        // Build on the main thread from here on; re-queue whatever was in flight.
        worker?.terminate();
        worker = null;
        inFlight = 0;
        requested.clear();
        bare = [];
        lastX = Infinity;
      };
    } catch {
      worker = null;
    }
  }

  function request(key: string): void {
    const { lod, cx, cz } = parseChunkKey(key);
    const message: WorkerRequest = { type: 'tile', key, level: lod, ix: cx, iz: cz, cells, objects, maps: true };
    if (!worker) throw new Error('land tiles requested without a worker');
    worker.postMessage(message);
    requested.add(key);
    inFlight++;
  }

  /**
   * Requests in queue order, then full builds of the first frame's bare tiles, nearest first, while the worker has
   * room; without a worker, one tile per call on the main thread.
   */
  function send(): void {
    while (queue.length && (!worker || inFlight < MAX_IN_FLIGHT)) {
      const key = queue.shift();
      if (key === undefined) break;
      if (tiles.has(key) || requested.has(key)) continue;
      const done = ready.get(key);
      if (done !== undefined) {
        if (wanted.has(key)) {
          arrived.push({ key, data: done });
          ready.delete(key);
        }
        continue;
      }
      if (worker) {
        request(key);
      } else {
        received(key, buildHere(key, true));
        return;
      }
    }
    while (worker && inFlight < MAX_IN_FLIGHT && bare.length) {
      const key = bare.shift();
      if (key === undefined) break;
      // A bare tile no longer wanted is on its way out: it needs no full build.
      if (tiles.get(key)?.bare && wanted.has(key) && !requested.has(key)) request(key);
    }
  }

  /** A built tile: queued for placement while wanted, otherwise held ready. */
  function received(key: string, data: TileData | null): void {
    // A bare tile's full build is placed like any arrival, a few per frame.
    if (wanted.has(key) || tiles.get(key)?.bare) {
      arrived.push({ key, data });
      return;
    }
    ready.delete(key);
    ready.set(key, data);
    trimOldest(ready, READY_CAP);
  }

  /** A tile's mesh: its shading maps bound for its own draws, its dissolve from the tile. */
  function makeMesh(tile: Tile, data: TileData, material: THREE.ShaderMaterial): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setAttribute('detail', new THREE.BufferAttribute(data.detail, 4, true));
    geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    const size = tileSize(tile.level);
    mesh.position.set(tile.ix * size, 0, tile.iz * size);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    const maps = data.maps ? [mapTexture(data.maps, data.maps.color, THREE.SRGBColorSpace), mapTexture(data.maps, data.maps.normal, THREE.NoColorSpace)] : null;
    if (maps) mesh.userData['maps'] = maps;
    mesh.onBeforeRender = () => {
      const material = mesh.material;
      // Uniforms go up again only when this draw's differ from the last land draw's.
      if (material !== dissolving && maps?.[0] === bound) return;
      bound = maps?.[0];
      uniforms.fade.value = tile.under ? tile.rise : tile.fade;
      uniforms.colorMap.value = maps?.[0] ?? null;
      uniforms.normalMap.value = maps?.[1] ?? null;
      uniforms.mapScale.value = maps ? 1 / size : 0;
      material.uniformsNeedUpdate = true;
    };
    group.add(mesh);
    return mesh;
  }

  function disposeMesh(mesh: THREE.Mesh): void {
    group.remove(mesh);
    mesh.geometry.dispose();
    for (const texture of (mesh.userData['maps'] as THREE.Texture[] | undefined) ?? []) texture.dispose();
  }

  function carry(tile: Tile, data: TileData): void {
    tile.triangles = data.triangles;
    tile.objectTriangles = data.objectTriangles;
    tile.objects = data.objects;
    tile.walkers = data.walkers;
  }

  function place(key: string, data: TileData | null, solidNow: boolean, isBare = false): void {
    if (tiles.has(key)) return;
    const { lod, cx, cz } = parseChunkKey(key);
    // Open sea has nothing to dissolve: it counts as solid at once.
    const on = solidNow || !data;
    const fadeTime = FADE * (0.8 + 0.4 * tileUnit(land.seed, lod, cx, cz));
    const tile: Tile = { key, level: lod, ix: cx, iz: cz, mesh: null, bare: isBare && Boolean(data), under: null, rise: 0, riseStart: 0, triangles: 0, objectTriangles: 0, objects: 0, walkers: null, fade: on ? 1 : 0, fadeTime, state: on ? 'on' : 'in' };
    if (data) {
      tile.mesh = makeMesh(tile, data, solidNow ? solid : dissolving);
      carry(tile, data);
    }
    tiles.set(key, tile);
    if (tile.walkers) walkerVersion++;
  }

  /** The full build of a bare tile: dissolves in over the bare mesh when the tile is solid, else replaces it. */
  function upgrade(tile: Tile, data: TileData | null): void {
    tile.bare = false;
    if (!data || !tile.mesh) return;
    if (tile.under) disposeMesh(tile.under);
    tile.under = null;
    if (tile.state === 'on') {
      tile.under = tile.mesh;
      tile.rise = 0;
      tile.riseStart = performance.now();
      tile.mesh = makeMesh(tile, data, dissolving);
    } else {
      const material = tile.mesh.material as THREE.ShaderMaterial;
      disposeMesh(tile.mesh);
      tile.mesh = makeMesh(tile, data, material);
    }
    carry(tile, data);
    walkerVersion++;
  }

  /** A tile built on the main thread: bare, or with its life; on the tier's own grid and without shading maps, which are worker work. */
  function buildHere(key: string, full: boolean): TileData | null {
    const { lod, cx, cz } = parseChunkKey(key);
    if (full && objects > 0) life ??= createLandLife(land);
    return buildTile(land, patchNoise, lod, cx, cz, cells, full && life ? { life, objects } : undefined, false, false);
  }

  function remove(tile: Tile): void {
    tiles.delete(tile.key);
    if (tile.walkers) walkerVersion++;
    if (tile.mesh) disposeMesh(tile.mesh);
    if (tile.under) disposeMesh(tile.under);
  }

  /** Whether a cell is drawn solid: by itself, an ancestor, or (two levels down at most) its children. */
  function solidAt(level: number, ix: number, iz: number): boolean {
    for (let l = level, x = ix, z = iz; l <= TOP_LEVEL; l++, x = Math.floor(x / 2), z = Math.floor(z / 2)) {
      if (tiles.get(chunkKey(l, x, z))?.state === 'on') return true;
    }
    const below = (l: number, x: number, z: number, depth: number): boolean => {
      if (tiles.get(chunkKey(l, x, z))?.state === 'on') return true;
      if (l === 0 || depth === 0) return false;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) if (!below(l - 1, x * 2 + i, z * 2 + j, depth - 1)) return false;
      return true;
    };
    return level > 0 && below(level, ix, iz, 2);
  }

  /**
   * Wanted tiles along the lead (ax, az); then tiles around the prefetch point.
   * Missing ones queue by need (uncovered first), then distance with seeded
   * jitter so a ring of equal tiles never arrives together.
   */
  function reselect(x: number, z: number, ax: number, az: number, px: number, pz: number): void {
    const next = new Set<string>();
    wantedList = selectTiles(x, z, split, next, STREAM_RADIUS, SPLIT, ax, az);
    split = next;
    wanted = new Set(wantedList);
    walkerVersion++;
    // Bare tiles still wanted get their full builds from the worker, nearest first.
    bare = worker ? wantedList.filter((key) => tiles.get(key)?.bare) : [];
    wantedCells = wantedList.map((key) => {
      const { lod, cx, cz } = parseChunkKey(key);
      return { key, level: lod, ix: cx, iz: cz };
    });
    const order = (keys: string[], bias: number) =>
      keys
        .filter((key) => !tiles.has(key) && !(bias && ready.has(key)))
        .map((key) => {
          const { lod, cx, cz } = parseChunkKey(key);
          const d = cellDistance(x, z, cx, cz, tileSize(lod)) * (0.8 + 0.4 * tileUnit(land.seed, lod, cx, cz));
          return { key, rank: bias + (solidAt(lod, cx, cz) ? d : -1) };
        })
        .sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : 1))
        .map((t) => t.key);
    const later = px === x && pz === z ? [] : selectTiles(px, pz, split, new Set()).filter((key) => !wanted.has(key));
    queue = [...order(wantedList, 0), ...order(later, 1e9)];
    lastX = x;
    lastZ = z;
    lastAX = ax;
    lastAZ = az;
  }

  /** True when every wanted tile overlapping `tile` is solid (or empty sea). */
  function covered(tile: Tile): boolean {
    for (const cell of wantedCells) {
      if (!overlaps(tile, cell)) continue;
      const other = tiles.get(cell.key);
      if (other?.state !== 'on') return false;
    }
    return true;
  }

  return {
    group,
    prime(x, z) {
      reselect(x, z, 0, 0, x, z);
      for (const key of wantedList) place(key, buildHere(key, !worker), true, Boolean(worker));
      bare = wantedList.filter((key) => tiles.get(key)?.bare);
      queue = [];
    },
    update(x, z, dt, vx = 0, vz = 0) {
      const [ax, az] = ahead(vx, vz, LEAD, LEAD_MAX);
      if (Math.max(Math.hypot(x - lastX, z - lastZ), Math.hypot(x + ax - lastX - lastAX, z + az - lastZ - lastAZ)) > RESELECT) {
        const [px, pz] = ahead(vx, vz, PREFETCH, PREFETCH_MAX);
        reselect(x, z, ax, az, x + px, z + pz);
      }
      send();
      for (let placed = 0, upgraded = 0; arrived.length && placed < PLACE_PER_FRAME && upgraded < UPGRADE_PER_FRAME; ) {
        const next = arrived.shift();
        if (!next) break;
        const { key, data } = next;
        const tile = tiles.get(key);
        if (tile?.bare) {
          upgrade(tile, data);
          upgraded++;
          continue;
        }
        if (tile) continue;
        if (!wanted.has(key)) {
          received(key, data);
          continue;
        }
        place(key, data, false);
        placed++;
      }
      // Without motion (reduced-motion preference) tiles swap at once.
      for (const tile of [...tiles.values()]) {
        const step = dt > 0 ? dt / tile.fadeTime : 1;
        if (tile.under) {
          // By the clock, not the frame step: while it lasts the tile draws twice, and slow frames must not stretch that.
          tile.rise = dt > 0 ? Math.min(1, (performance.now() - tile.riseStart) / (tile.fadeTime * 1000)) : 1;
          if (tile.rise >= 1 || tile.state !== 'on') {
            disposeMesh(tile.under);
            tile.under = null;
            if (tile.mesh && tile.state === 'on') tile.mesh.material = solid;
          }
        }
        const want = wanted.has(tile.key);
        if (want && tile.state === 'out') tile.state = 'in';
        if (!want && tile.state !== 'out' && covered(tile)) tile.state = 'out';
        if (tile.state === 'in') {
          tile.fade = Math.min(1, tile.fade + step);
          if (tile.fade >= 1) {
            tile.state = 'on';
            completed++;
            if (tile.mesh) tile.mesh.material = solid;
          }
        } else if (tile.state === 'out') {
          if (tile.mesh) tile.mesh.material = dissolving;
          tile.fade = Math.max(0, tile.fade - step);
          if (tile.fade <= 0 || !tile.mesh) remove(tile);
        }
      }
      holes = 0;
      for (const cell of wantedCells) {
        if (tiles.get(cell.key)?.state === 'on') continue;
        if (cellDistance(x, z, cell.ix, cell.iz, tileSize(cell.level)) < HAZE_END && !solidAt(cell.level, cell.ix, cell.iz)) holes++;
      }
    },
    setLook(hazeDensity, tint) {
      look = hazeDensity;
      uniforms.hazeDensity.value = baseDensity * look;
      uniforms.landTint.value.copy(tint);
    },
    setSky(direction, sunColor, haze, density, light) {
      sun.copy(direction).normalize();
      // The sun's hue at the tint's own brightness: low suns light the slopes gold.
      sunTint.copy(sunColor).multiplyScalar(SUN_TINT_LUMA / Math.max(1e-4, luma(sunColor)));
      for (let k = 0; k < uniforms.hazeColors.value.length; k++) item(uniforms.hazeColors.value, k).copy(item(haze, Math.min(k, haze.length - 1)));
      baseDensity = density;
      uniforms.hazeDensity.value = baseDensity * look;
      uniforms.landLight.value = light;
    },
    setOrigin(x, z) {
      uniforms.origin.value.set(x, z);
    },
    uniforms,
    materials: [solid, dissolving],
    hazeStops: gradient.angles.length,
    walkerTiles() {
      const list: WalkerTile[] = [];
      for (const tile of tiles.values()) {
        if (!tile.walkers || tile.state === 'out' || !wanted.has(tile.key)) continue;
        const size = tileSize(tile.level);
        list.push({ x0: tile.ix * size, z0: tile.iz * size, level: tile.level, data: tile.walkers });
      }
      return list;
    },
    walkerVersion: () => walkerVersion,
    tileState: (key) => tiles.get(key)?.state,
    stats() {
      let triangles = 0;
      let objectTriangles = 0;
      let objectCount = 0;
      let fading = 0;
      for (const tile of tiles.values()) {
        triangles += tile.triangles;
        if (wanted.has(tile.key) && tile.state !== 'out') {
          objectTriangles += tile.objectTriangles;
          objectCount += tile.objects;
        }
        if (tile.state !== 'on' || tile.under) fading++;
      }
      return { tiles: tiles.size, triangles, objectTriangles, objects: objectCount, pending: queue.length + requested.size + arrived.length + bare.length, fading, ready: ready.size, holes, completed };
    },
    dispose() {
      worker?.terminate();
      for (const tile of [...tiles.values()]) remove(tile);
      solid.dispose();
      dissolving.dispose();
    },
  };
}
