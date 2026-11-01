// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonAdjacencyStore } from '../../src/lib/adjacency/store';
import { loadAdjacency } from '../../src/lib/adjacency';
import { trackKeyOf } from '../../src/types/track';

const T = (artist: string, title: string) => ({ artist, title });
const A = T('Artist A', 'Alpha');
const B = T('Artist B', 'Beta');
const C = T('Artist C', 'Gamma');
const D = T('Artist D', 'Delta');
const k = (t: { artist: string; title: string }) => trackKeyOf(t.artist, t.title);

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adj-'));
  file = path.join(dir, 'adjacency.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('JsonAdjacencyStore', () => {
  it('records directional neighbor counts across tracklists sharing tracks', async () => {
    const s = new JsonAdjacencyStore(file);
    await s.ingest('tl1', [A, B, C]);
    await s.ingest('tl2', [A, B, D]);
    expect(await s.getNeighbors(k(B))).toEqual(
      expect.arrayContaining([
        { trackKey: k(A), count: 2, direction: 'before' },
        { trackKey: k(C), count: 1, direction: 'after' },
        { trackKey: k(D), count: 1, direction: 'after' },
      ])
    );
    expect(await s.getNeighbors(k(B))).toHaveLength(3);
    expect(await s.getNeighbors(k(A))).toEqual([{ trackKey: k(B), count: 2, direction: 'after' }]);
    expect(await s.getNeighbors(k(C))).toEqual([{ trackKey: k(B), count: 1, direction: 'before' }]);
  });

  it('is idempotent: re-ingesting the same tracklist id does not double-count', async () => {
    const s = new JsonAdjacencyStore(file);
    expect(await s.ingest('tl1', [A, B, C])).toBe(true);
    expect(await s.ingest('tl1', [A, B, C])).toBe(false);
    expect(await s.getNeighbors(k(B))).toContainEqual({ trackKey: k(A), count: 1, direction: 'before' });
    expect(await s.hasTracklist('tl1')).toBe(true);
    expect(await s.hasTracklist('nope')).toBe(false);
  });

  it('ignores self-adjacency from consecutive duplicate tracks', async () => {
    const s = new JsonAdjacencyStore(file);
    await s.ingest('tl1', [A, A, B]);
    expect(await s.getNeighbors(k(A))).toEqual([{ trackKey: k(B), count: 1, direction: 'after' }]);
  });

  it('persists to disk and reloads', async () => {
    const s = new JsonAdjacencyStore(file);
    await s.ingest('tl1', [A, B, C]);
    const again = new JsonAdjacencyStore(file);
    expect(await again.getNeighbors(k(B))).toHaveLength(2);
    expect(await again.stats()).toEqual({ tracklistCount: 1, trackCount: 3, pairCount: 2 });
  });

  it('reports empty stats and no neighbors on a missing file', async () => {
    const s = new JsonAdjacencyStore(file);
    expect(await s.stats()).toEqual({ tracklistCount: 0, trackCount: 0, pairCount: 0 });
    expect(await s.getNeighbors('x|y')).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
});

describe('loadAdjacency', () => {
  it('returns a lookup with counts, from the given file', async () => {
    await new JsonAdjacencyStore(file).ingest('tl1', [A, B, C]);
    const adj = await loadAdjacency(file);
    expect(adj.pairCount).toBe(2);
    expect(adj.trackCount).toBe(3);
    expect(await adj.getNeighbors(k(A))).toHaveLength(1);
  });

  it('returns an empty lookup when the file does not exist', async () => {
    const adj = await loadAdjacency(file);
    expect(adj.pairCount).toBe(0);
    expect(await adj.getNeighbors('a|b')).toEqual([]);
  });
});

describe('JsonAdjacencyStore cross-process safety', () => {
  const mk = (file: string) => new JsonAdjacencyStore(file, { recheckMs: 0 });
  it('a stale instance merges onto the fresh file instead of overwriting it', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'xproc-'));
    const file = path.join(d, 'adjacency.json');
    const a = mk(file);
    const b = mk(file);
    await b.getNeighbors('warm'); // b loads the (empty) file and caches it
    await a.ingest('t1', [{ artist: 'A', title: 'One' }, { artist: 'B', title: 'Two' }]);
    await b.ingest('t2', [{ artist: 'C', title: 'Three' }, { artist: 'D', title: 'Four' }]);
    const fresh = mk(file);
    expect(await fresh.hasTracklist('t1')).toBe(true);
    expect(await fresh.hasTracklist('t2')).toBe(true);
    b.setPlayCount('x|y', 5);
    expect(mk(file).playCountOf('x|y')).toBe(5);
    expect(await mk(file).hasTracklist('t1')).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
  it('a stale reader sees another process growth after the file changes', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'xproc-'));
    const file = path.join(d, 'adjacency.json');
    const a = mk(file);
    const b = mk(file);
    await b.getNeighbors('warm');
    await a.ingest('t1', [{ artist: 'A', title: 'One' }, { artist: 'B', title: 'Two' }]);
    expect((await b.getNeighbors(trackKeyOf('A', 'One'))).length).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });
});
