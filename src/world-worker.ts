import { createLand, farShelf, type Land } from './land.js';
import { makeNoise2D } from './noise.js';
import { buildTile } from './world-tiles.js';
import { createLandLife, type LandLife } from './land-life.js';
import type { NoiseFunction2D } from 'simplex-noise';

/**
 * Land worker: rebuilds the same land from (seed, viewYaw, offset) and answers
 * tile and far-shelf requests, so streaming never stalls a frame.
 */
export type WorkerRequest =
  | { type: 'init'; seed: number; viewYaw: number; offset: { x: number; z: number } }
  | { type: 'tile'; key: string; level: number; ix: number; iz: number; cells: number; objects: number; maps: boolean }
  | { type: 'far'; id: number; size: number; extent: number; cx: number; cz: number };

let land: Land | null = null;
let patch: NoiseFunction2D | null = null;
let life: LandLife | null = null;
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    land = createLand(message.seed, { viewYaw: message.viewYaw, offset: message.offset });
    patch = makeNoise2D(message.seed, 21);
    life = createLandLife(land);
    return;
  }
  if (!land || !patch || !life) return;
  if (message.type === 'tile') {
    const data = buildTile(land, patch, message.level, message.ix, message.iz, message.cells, message.objects > 0 ? { life, objects: message.objects } : undefined, message.maps);
    const transfer = data
      ? [data.positions.buffer, data.normals.buffer, data.colors.buffer, data.detail.buffer, data.index.buffer, ...(data.walkers ? [data.walkers.buffer] : []), ...(data.maps ? [data.maps.color.buffer, data.maps.normal.buffer] : [])]
      : [];
    scope.postMessage({ type: 'tile', key: message.key, data }, transfer);
  } else {
    const shelf = farShelf(land, message.size, message.extent, message.cx, message.cz);
    scope.postMessage({ type: 'far', id: message.id, shelf }, [shelf.data.buffer]);
  }
};
