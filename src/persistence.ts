import { isPace, type Pace } from './pace.js';

export const STORAGE_KEY = 'ejm-calm:v1';
export const VERSION = 1;

export interface CalmMemory {
  version: number;
  seed: number;
  sound?: { enabled: boolean; volume: number };
  framing?: { yaw: number; pitch: number; distance: number };
  /** Show the region and distance when the whale enters a new region (off unless set). */
  route?: boolean;
  /** Travel speed choice (normal unless set). */
  pace?: Pace;
  /** Follow the whale down on its dives (on unless set to false). */
  dives?: boolean;
}

export function validateMemory(value: unknown): value is CalmMemory {
  if (!value || typeof value !== 'object') return false;
  const data = value as CalmMemory;
  if (data.version !== VERSION) return false;
  if (!Number.isInteger(data.seed) || data.seed < 0 || data.seed > 0xffffffff) return false;
  if (data.sound) {
    if (typeof data.sound.enabled !== 'boolean') return false;
    if (typeof data.sound.volume !== 'number' || !Number.isFinite(data.sound.volume) || data.sound.volume < 0 || data.sound.volume > 1) return false;
  }
  if (data.route !== undefined && typeof data.route !== 'boolean') return false;
  if (data.dives !== undefined && typeof data.dives !== 'boolean') return false;
  if (data.pace !== undefined && !isPace(data.pace)) return false;
  if (data.framing) {
    const { yaw, pitch, distance } = data.framing;
    if (![yaw, pitch, distance].every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
    if (pitch < 0 || pitch > 1.2 || distance < 5 || distance > 200) return false;
  }
  return true;
}

export function loadMemory(storage: Storage | null | undefined): CalmMemory | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return validateMemory(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveMemory(storage: Storage | null | undefined, memory: CalmMemory): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Quota or private mode — ignore.
  }
}
