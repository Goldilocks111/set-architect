import path from 'node:path';
import type { AdjacencyLookup } from '../../types/track';
import { JsonAdjacencyStore } from './store';

export * from './store';
export { buildDemoAdjacency, DEMO_ADJACENCY_PATH, DEMO_TRACKS_PATH } from './demo';

export const ADJACENCY_PATH = path.join(process.cwd(), 'data', 'index', 'adjacency.json');

export async function loadAdjacency(
  file: string = ADJACENCY_PATH
): Promise<AdjacencyLookup & { pairCount: number; trackCount: number }> {
  const store = new JsonAdjacencyStore(file);
  const { pairCount, trackCount } = await store.stats();
  return { getNeighbors: (key) => store.getNeighbors(key), pairCount, trackCount };
}
