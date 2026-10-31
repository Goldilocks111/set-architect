// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildDemoAdjacency, loadAdjacency, DEMO_TRACKS_PATH } from '../../src/lib/adjacency';
import { trackKeyOf, type Track } from '../../src/types/track';

describe('buildDemoAdjacency', () => {
  it('generates plausible adjacency with counts 1-5 for seed tracks', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'demo-'));
    const out = path.join(dir, 'adj.json');
    try {
      buildDemoAdjacency(DEMO_TRACKS_PATH, out);
      const adj = await loadAdjacency(out);
      expect(adj.pairCount).toBeGreaterThan(10);
      const tracks = JSON.parse(readFileSync(DEMO_TRACKS_PATH, 'utf8')) as Track[];
      let seen = 0;
      for (const t of tracks) {
        for (const n of await adj.getNeighbors(trackKeyOf(t.artist, t.title))) {
          expect(n.count).toBeGreaterThanOrEqual(1);
          expect(n.count).toBeLessThanOrEqual(5);
          seen++;
        }
      }
      expect(seen).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
