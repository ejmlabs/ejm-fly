import { fork, hash } from './rng.js';
import { clamp, distance2 } from './math.js';
import { createLand, type Land } from './land.js';
import { clampClearOfLand } from './shore.js';
import { item } from './item.js';

export interface ShipSpec {
  id: number;
  x: number;
  z: number;
  heading: number;
  scale: number;
  kind: 'sloop' | 'tall';
  seed: number;
}

export interface WorldLayout {
  land: Land;
  ships: ShipSpec[];
  whaleHome: { x: number; z: number };
  /** Camera yaw (radians): subjects in look direction (−sin, −cos). */
  viewYaw: number;
  /** Whale heading the journey keeps: the planet's migration heading, out of the opening by its exit. */
  journey: number;
}

/** Camera look direction on XZ for a yaw (matches CalmCamera). */
export function lookDirXZ(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/** Point along camera look from an origin (camera convention). */
export function pointAlongYaw(
  yaw: number,
  dist: number,
  origin: { x: number; z: number } = { x: 0, z: 0 },
): { x: number; z: number } {
  const d = lookDirXZ(yaw);
  return { x: origin.x + d.x * dist, z: origin.z + d.z * dist };
}

/**
 * True if `point` lies inside a portrait half-cone around the look direction
 * from `focus` (default half-angle ~38°, enough for FOV 62° × ~9:16).
 */
export function inPortraitViewCone(
  yaw: number,
  focus: { x: number; z: number },
  point: { x: number; z: number },
  halfConeRad = (38 * Math.PI) / 180,
): boolean {
  const look = lookDirXZ(yaw);
  const dx = point.x - focus.x;
  const dz = point.z - focus.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return true;
  const dot = (dx / len) * look.x + (dz / len) * look.z;
  const angle = Math.acos(clamp(dot, -1, 1));
  return angle <= halfConeRad;
}

function placeAway(
  rng: () => number,
  existing: { x: number; z: number; radius: number }[],
  minR: number,
  maxR: number,
  clearance: number,
  attempts = 48,
  /** When set, place along camera yaw convention (−sin/−cos). */
  yawBias?: { center: number; spread: number },
  water: (x: number, z: number) => boolean = () => true,
): { x: number; z: number } | null {
  for (let i = 0; i < attempts; i++) {
    const angle = yawBias
      ? yawBias.center + (rng() - 0.5) * 2 * yawBias.spread
      : rng() * Math.PI * 2;
    const dist = minR + rng() * (maxR - minR);
    // Camera convention: lookDir = (−sin θ, −cos θ).
    const x = -Math.sin(angle) * dist;
    const z = -Math.cos(angle) * dist;
    let ok = water(x, z);
    for (const other of existing) {
      if (distance2(x, z, other.x, other.z) < other.radius + clearance) {
        ok = false;
        break;
      }
    }
    if (ok) return { x, z };
  }
  return null;
}

function shortestAngle(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/**
 * Subject-derived camera yaw: hero ship primary, nearest-in-front coast secondary.
 * Sun azimuth is only a tiebreak.
 */
export function computeViewYaw(
  whale: { x: number; z: number },
  hero: { x: number; z: number },
  landmarks: readonly { x: number; z: number }[],
  sunAzimuthDeg: number,
): number {
  const sunYaw = (sunAzimuthDeg * Math.PI) / 180;
  // Focus matches main.ts: whale 0.78 + hero 0.22.
  const focus = {
    x: whale.x * 0.78 + hero.x * 0.22,
    z: whale.z * 0.78 + hero.z * 0.22,
  };

  // Hero is the primary subject — yaw must keep it in the portrait cone.
  const heroDx = hero.x - focus.x;
  const heroDz = hero.z - focus.z;
  const heroLen = Math.hypot(heroDx, heroDz);
  let yaw =
    heroLen > 1e-3
      ? Math.atan2(-heroDx / heroLen, -heroDz / heroLen)
      : sunYaw;

  // Nearest landmark already roughly in front of the hero heading (ignore anything behind).
  let nearest: { x: number; z: number } | null = null;
  let nearestD = Infinity;
  const front = lookDirXZ(yaw);
  for (const mark of landmarks) {
    const dx = mark.x - focus.x;
    const dz = mark.z - focus.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const dot = (dx / len) * front.x + (dz / len) * front.z;
    if (dot < 0.55) continue; // outside ~±57°
    if (len < nearestD) {
      nearestD = len;
      nearest = mark;
    }
  }

  if (nearest) {
    const dx = nearest.x - focus.x;
    const dz = nearest.z - focus.z;
    const len = Math.hypot(dx, dz);
    const islandYaw = Math.atan2(-dx / len, -dz / len);
    const delta = shortestAngle(yaw, islandYaw);
    // Soft pull toward the silhouette; keep hero inside a ~30° half-cone.
    yaw += clamp(delta, -0.35, 0.35) * 0.28;
  }

  // Sun glitter as tiebreak only.
  {
    const delta = shortestAngle(yaw, sunYaw);
    yaw += clamp(delta, -0.12, 0.12) * 0.25;
  }
  return yaw;
}

/** Nearest land in front of the focus, marching rays across the portrait cone. */
export function coastAhead(
  land: Land,
  yaw: number,
  focus: { x: number; z: number },
  maxDist = 2600,
  halfConeRad = (30 * Math.PI) / 180,
): { x: number; z: number; dist: number } | null {
  let best: { x: number; z: number; dist: number } | null = null;
  for (let i = 0; i <= 12; i++) {
    const a = yaw + (i / 12 - 0.5) * 2 * halfConeRad;
    const dir = lookDirXZ(a);
    for (let d = 60; d <= maxDist; d += 30) {
      if (best && d >= best.dist) break;
      const x = focus.x + dir.x * d;
      const z = focus.z + dir.z * d;
      if (land.maskAt(x, z) > 0) {
        best = { x, z, dist: d };
        break;
      }
    }
  }
  return best;
}

/** Ships keep this much water between hull and coast. */
export const SHIP_LAND_MARGIN = 40;

export function layoutWorld(seed: number, sunAzimuthDeg = 185, options: { gridSize?: number } = {}): WorldLayout {
  const rng = fork(seed, 'layout');
  const sunYaw = (sunAzimuthDeg * Math.PI) / 180;
  const occupied: { x: number; z: number; radius: number }[] = [];

  // Whale first (near origin), then hero along sun; land is then anchored in that view.
  const whalePos = placeAway(rng, occupied, 8, 36, 22) ?? { x: 10, z: -16 };
  occupied.push({ x: whalePos.x, z: whalePos.z, radius: 16 });

  const shipCount = 2 + Math.floor(rng() * 4); // 2–5
  const ships: ShipSpec[] = [];

  const heroPos = placeAway(
    rng,
    occupied,
    70,
    130,
    18,
    60,
    { center: sunYaw, spread: (14 * Math.PI) / 180 },
  ) ?? pointAlongYaw(sunYaw, 95, whalePos);
  const heroKind: ShipSpec['kind'] = rng() > 0.4 ? 'tall' : 'sloop';
  ships.push({
    id: 0,
    x: heroPos.x,
    z: heroPos.z,
    heading: sunYaw + Math.PI * 0.5,
    scale: heroKind === 'tall' ? 1.35 * (1.1 + rng() * 0.25) : 1.0 + rng() * 0.25,
    kind: heroKind,
    seed: hash(seed, 'ship', 0),
  });

  // Provisional subject yaw (hero-primary) anchors the land ahead of the camera.
  let viewYaw = computeViewYaw(whalePos, item(ships, 0), [], sunAzimuthDeg);
  const land = createLand(seed, { viewYaw, gridSize: options.gridSize });

  // The harbour is open water, but make sure of it.
  const whaleHome = clampClearOfLand(whalePos.x, whalePos.z, land, SHIP_LAND_MARGIN + 60);
  {
    const hero = item(ships, 0);
    const clear = clampClearOfLand(hero.x, hero.z, land, SHIP_LAND_MARGIN);
    hero.x = clear.x;
    hero.z = clear.z;
    occupied.push({ x: hero.x, z: hero.z, radius: 14 });
  }

  const water = (x: number, z: number) => land.clearance(x, z) > SHIP_LAND_MARGIN;
  for (let i = 1; i < shipCount; i++) {
    const pos = placeAway(rng, occupied, 50, 220, 18, 48, undefined, water);
    if (!pos) continue;
    const kind: ShipSpec['kind'] = rng() > 0.55 ? 'tall' : 'sloop';
    const spec: ShipSpec = {
      id: i,
      x: pos.x,
      z: pos.z,
      heading: rng() * Math.PI * 2,
      scale: kind === 'tall' ? 1.3 * (1.05 + rng() * 0.3) : 0.85 + rng() * 0.3,
      kind,
      seed: hash(seed, 'ship', i),
    };
    ships.push(spec);
    occupied.push({ x: spec.x, z: spec.z, radius: 12 });
  }

  // Keep the yaw the land was composed for; pulling toward a coast afterwards
  // would drift the frame off the scored composition.
  viewYaw = computeViewYaw(whaleHome, item(ships, 0), [], sunAzimuthDeg);

  // Re-aim hero heading so sails read sideways to the camera.
  item(ships, 0).heading = viewYaw + Math.PI * 0.5 + (rng() - 0.5) * 0.25;

  return {
    land,
    ships,
    whaleHome,
    viewYaw,
    journey: land.planet.heading,
  };
}
