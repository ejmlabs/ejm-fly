import { item } from './item.js';
/** Simple boids: separation, alignment and cohesion within a group, plus a pull toward that group's leader. */
export interface Boid { x: number; y: number; z: number; vx: number; vy: number; vz: number; group: number; size: number }
export interface Leader { x: number; y: number; z: number }
export interface FlockParams {
  /** Metres per second for each group (cruise speed). */
  speeds: readonly number[];
  /** Lowest height above the water (m). */
  minHeight: number;
  maxHeight: number;
}

const SEPARATION = 7;
const NEIGHBOURS = 55;

/** Advance every boid by `dt` seconds. O(n²) on at most a couple of dozen birds. */
export function stepFlock(boids: Boid[], leaders: readonly Leader[], params: FlockParams, dt: number): void {
  if (dt <= 0) return;
  for (const bird of boids) {
    const leader = item(leaders, bird.group);
    const cruise = params.speeds[bird.group] ?? 0;
    let sepX = 0, sepY = 0, sepZ = 0;
    let avgVx = 0, avgVz = 0, avgX = 0, avgY = 0, avgZ = 0;
    let near = 0;
    for (const other of boids) {
      if (other === bird) continue;
      const dx = bird.x - other.x, dy = bird.y - other.y, dz = bird.z - other.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const reach = SEPARATION * (bird.size + other.size) * 0.5;
      if (d2 < reach * reach && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (reach - d) / reach;
        sepX += (dx / d) * push;
        sepY += (dy / d) * push;
        sepZ += (dz / d) * push;
      }
      if (other.group === bird.group && d2 < NEIGHBOURS * NEIGHBOURS) {
        avgVx += other.vx; avgVz += other.vz;
        avgX += other.x; avgY += other.y; avgZ += other.z;
        near++;
      }
    }
    let ax = sepX * 4, ay = sepY * 4, az = sepZ * 4;
    if (near > 0) {
      ax += (avgVx / near - bird.vx) * 0.4 + (avgX / near - bird.x) * 0.02;
      ay += (avgY / near - bird.y) * 0.02;
      az += (avgVz / near - bird.vz) * 0.4 + (avgZ / near - bird.z) * 0.02;
    }
    // Pull toward the leader grows with distance; a straggler also flies a little faster to catch up.
    const lx = leader.x - bird.x, ly = leader.y - bird.y, lz = leader.z - bird.z;
    const lead = Math.hypot(lx, ly, lz);
    const pull = Math.min(1, lead / 120) * 0.9 + 0.05;
    ax += (lx / (lead + 1e-6)) * pull * cruise * 0.35;
    ay += (ly / (lead + 1e-6)) * pull * cruise * 0.2;
    az += (lz / (lead + 1e-6)) * pull * cruise * 0.35;

    bird.vx += ax * dt;
    bird.vy += ay * dt;
    bird.vz += az * dt;
    const limit = cruise * (1 + Math.min(0.6, lead / 400));
    const speed = Math.hypot(bird.vx, bird.vy, bird.vz);
    if (speed > limit) {
      const scale = limit / speed;
      bird.vx *= scale; bird.vy *= scale; bird.vz *= scale;
    }
    // Keep a steady forward pace: never hover, never climb or dive steeply.
    const flat = Math.hypot(bird.vx, bird.vz);
    const floor = cruise * 0.6;
    if (flat < floor) {
      const heading = flat > 1e-6 ? 1 / flat : 0;
      bird.vx = flat > 1e-6 ? bird.vx * heading * floor : floor;
      bird.vz = flat > 1e-6 ? bird.vz * heading * floor : 0;
    }
    const maxClimb = Math.hypot(bird.vx, bird.vz) * 0.3;
    bird.vy = Math.max(-maxClimb, Math.min(maxClimb, bird.vy));

    bird.x += bird.vx * dt;
    bird.y += bird.vy * dt;
    bird.z += bird.vz * dt;
    if (bird.y < params.minHeight) {
      bird.y = params.minHeight;
      bird.vy = Math.max(0, bird.vy);
    } else if (bird.y > params.maxHeight) {
      bird.y = params.maxHeight;
      bird.vy = Math.min(0, bird.vy);
    }
  }
}
