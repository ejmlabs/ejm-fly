/** Critically damped spring: position and velocity, stepped in closed form. */
export interface Spring { x: number; v: number }

export const createSpring = (x = 0): Spring => ({ x, v: 0 });

/**
 * Exact critically damped step toward `target` with angular frequency `omega`.
 * Closed form, so any split of the same span of time lands on the same state.
 */
export function springStep(s: Spring, target: number, omega: number, dt: number): number {
  if (!(dt > 0)) return s.x;
  const delta = s.x - target;
  const e = Math.exp(-omega * dt);
  const k = (s.v + omega * delta) * dt;
  s.x = target + (delta + k) * e;
  s.v = (s.v - omega * k) * e;
  return s.x;
}

/** The equivalent of `angle` (mod 2π) nearest to `reference`. */
export function nearestAngle(angle: number, reference: number): number {
  const d = angle - reference;
  return reference + d - 2 * Math.PI * Math.round(d / (2 * Math.PI));
}

/** springStep for angles: always turns the short way; the state itself is never wrapped. */
export function springStepAngle(s: Spring, target: number, omega: number, dt: number): number {
  return springStep(s, nearestAngle(target, s.x), omega, dt);
}

/** Jump to `target` at rest. */
export function springSet(s: Spring, target: number): number {
  s.x = target;
  s.v = 0;
  return target;
}
