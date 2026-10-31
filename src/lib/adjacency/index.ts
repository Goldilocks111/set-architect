import path from 'node:path';
import { dataDir } from '@/lib/dataDir';
import type { AdjacencyLookup } from '../../types/track';
import { JsonAdjacencyStore } from './store';

export * from './store';
export { ensureNeighborsFor, isDigging } from './live';
export { buildDemoAdjacency, DEMO_ADJACENCY_PATH, DEMO_TRACKS_PATH } from './demo';

export const ADJACENCY_PATH = dataDir('index', 'adjacency.json');

export async function loadAdjacency(
  file: string = ADJACENCY_PATH
): Promise<AdjacencyLookup & { pairCount: number; trackCount: number; playCountOf: (key: string) => number | undefined }> {
  const store = new JsonAdjacencyStore(file);
  const { pairCount, trackCount } = await store.stats();
  return { getNeighbors: (key) => store.getNeighbors(key), pairCount, trackCount, playCountOf: (key) => store.playCountOf(key) };
}
