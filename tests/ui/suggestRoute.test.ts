import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { assembleSuggestions, displayFromKey, loadSuggestDeps, type SuggestDeps } from '@/app/api/suggest/assemble';
import { demoTracks } from '@/lib/demo';
import { trackKeyOf, type Track } from '@/types/track';

const mocks = vi.hoisted(() => ({
  resolver: {
    searchTracks: vi.fn(),
    resolveTrack: vi.fn(),
    getSimilarTracks: vi.fn(),
  },
  adjacency: {
    loadAdjacency: vi.fn(),
    readData: vi.fn(),
    ADJACENCY_PATH: '/index/adjacency.json',
    DEMO_ADJACENCY_PATH: '/seed/adjacency.demo.json',
  },
}));

vi.mock('@/lib/resolver', () => mocks.resolver);
vi.mock('@/lib/adjacency', () => mocks.adjacency);

const seed = demoTracks();
const last = seed[0];

describe('assembleSuggestions (demo data, no external deps)', () => {
  it('returns ≤10 suggestions, each with reasons, from the demo pool', async () => {
    const res = await assembleSuggestions({ playlist: [last], template: '60min', plannedLength: 15 }, {});
    expect(res.suggestions.length).toBeGreaterThan(0);
    expect(res.suggestions.length).toBeLessThanOrEqual(10);
    for (const s of res.suggestions) {
      expect(s.reasons.length).toBeGreaterThan(0);
      expect(Number.isFinite(s.score)).toBe(true);
    }
  });

  it('never suggests a track already in the set (by id or by artist/title key)', async () => {
    const dupWithOtherId: Track = { ...seed[1], id: 'resolved-xyz' };
    const deps: SuggestDeps = {
      getSimilarTracks: async () => [{ artist: seed[1].artist, title: seed[1].title, match: 0.9 }],
      resolveTrack: async () => dupWithOtherId,
    };
    const res = await assembleSuggestions(
      { playlist: [seed[1], last], template: '60min', plannedLength: 15 },
      deps
    );
    const keys = res.suggestions.map((s) => trackKeyOf(s.track.artist, s.track.title));
    expect(keys).not.toContain(trackKeyOf(seed[1].artist, seed[1].title));
    expect(keys).not.toContain(trackKeyOf(last.artist, last.title));
  });

  it('works with an empty set (arc-start suggestions)', async () => {
    const res = await assembleSuggestions({ playlist: [], template: '120min', plannedLength: 30 }, {});
    expect(res.suggestions.length).toBe(10);
  });

  it('adds adjacency neighbors (after-direction) and similar tracks to candidates and passes maps', async () => {
    const neighbor: Track = { id: 'ext-1', artist: 'Outside', title: 'Neighbor', bpm: 122, camelot: '9A', energy: 5, sources: {} };
    const similar: Track = { id: 'ext-2', artist: 'Other', title: 'Similar', bpm: 122, camelot: '9A', energy: 5, sources: {} };
    const getNeighbors = vi.fn(async () => [
      { trackKey: trackKeyOf('Outside', 'Neighbor'), count: 4, direction: 'after' as const },
      { trackKey: trackKeyOf('Before', 'Only'), count: 9, direction: 'before' as const },
    ]);
    const resolveTrack = vi.fn(async (artist: string, title: string) =>
      trackKeyOf(artist, title) === trackKeyOf('Outside', 'Neighbor') ? neighbor : similar
    );
    const suggestNext = vi.fn((_args: unknown) => []);
    await assembleSuggestions(
      { playlist: [last], template: '60min', plannedLength: 15 },
      {
        loadAdjacency: async () => ({ getNeighbors, pairCount: 1, trackCount: 2 }),
        getSimilarTracks: async () => [{ artist: 'Other', title: 'Similar', match: 0.7 }],
        resolveTrack,
        suggestNext,
      }
    );
    expect(getNeighbors).toHaveBeenCalledWith(trackKeyOf(last.artist, last.title));
    const args = suggestNext.mock.calls[0][0] as {
      candidates: Track[];
      adjacency: Map<string, number>;
      similarity: Map<string, number>;
    };
    const ids = args.candidates.map((c) => c.id);
    expect(ids).toContain('ext-1');
    expect(ids).toContain('ext-2');
    expect(args.adjacency.get(trackKeyOf('Outside', 'Neighbor'))).toBe(4);
    expect(args.adjacency.has(trackKeyOf('Before', 'Only'))).toBe(false);
    expect(args.similarity.get(trackKeyOf('Other', 'Similar'))).toBe(0.7);
    expect(resolveTrack).toHaveBeenCalledTimes(2);
  });

  it('degrades to demo pool when deps throw', async () => {
    const res = await assembleSuggestions(
      { playlist: [last], template: '60min', plannedLength: 15 },
      {
        loadAdjacency: async () => {
          throw new Error('no index');
        },
        getSimilarTracks: async () => {
          throw new Error('offline');
        },
      }
    );
    expect(res.suggestions.length).toBeGreaterThan(0);
  });
});

describe('metadata cache first, incomplete exclusion', () => {
  const full = { bpm: 122, camelot: '9A', energy: 5, danceability: 0.7 };
  const neighborKey = trackKeyOf('Outside', 'Neighbor');
  const deps = (over: SuggestDeps = {}): SuggestDeps => ({
    loadAdjacency: async () => ({
      getNeighbors: async () => [{ trackKey: neighborKey, count: 4, direction: 'after' as const }],
      pairCount: 1,
      trackCount: 2,
    }),
    ...over,
  });

  it('a complete cache entry supplies the candidate without calling resolveTrack', async () => {
    const resolveTrack = vi.fn(async () => ({ id: 'r', artist: 'Outside', title: 'Neighbor', sources: {} }) as Track);
    const getCachedEntry = vi.fn((k: string) => (k === neighborKey ? { fields: { ...full } } : undefined));
    const suggestNext = vi.fn((_a: unknown) => []);
    await assembleSuggestions(
      { playlist: [last], template: '60min', plannedLength: 15 },
      deps({ resolveTrack, getCachedEntry, suggestNext })
    );
    expect(resolveTrack).not.toHaveBeenCalled();
    const cands = (suggestNext.mock.calls[0][0] as { candidates: Track[] }).candidates;
    const hit = cands.find((c) => trackKeyOf(c.artist, c.title) === neighborKey)!;
    expect(hit).toMatchObject({ bpm: 122, camelot: '9A', energy: 5, danceability: 0.7 });
  });

  it('an incomplete cache entry falls through to resolveTrack', async () => {
    const resolveTrack = vi.fn(async () => ({ id: 'r', artist: 'Outside', title: 'Neighbor', sources: {}, ...full }) as Track);
    await assembleSuggestions(
      { playlist: [last], template: '60min', plannedLength: 15 },
      deps({ resolveTrack, getCachedEntry: () => ({ fields: { bpm: 122 } }) })
    );
    expect(resolveTrack).toHaveBeenCalledTimes(1);
  });

  it('cache hits do not consume the external lookup count', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => trackKeyOf('Cached', `T${i}`));
    const resolveTrack = vi.fn(async (a: string, t: string) => ({ id: `r-${t}`, artist: a, title: t, sources: {}, ...full }) as Track);
    const suggestNext = vi.fn((_a: unknown) => []);
    await assembleSuggestions(
      { playlist: [last], template: '60min', plannedLength: 15 },
      deps({
        loadAdjacency: async () => ({
          getNeighbors: async () => keys.map((trackKey) => ({ trackKey, count: 1, direction: 'after' as const })),
          pairCount: 1,
          trackCount: 12,
        }),
        resolveTrack,
        getCachedEntry: (k) => (keys.slice(0, 6).includes(k) ? { fields: { ...full } } : undefined),
        suggestNext,
      })
    );
    // 8 neighbors max considered; 6 hit the cache, so only the 2 misses resolve.
    expect(resolveTrack).toHaveBeenCalledTimes(2);
  });

  it('an incomplete last set track is not used for neighbor lookup; all-incomplete still yields suggestions', async () => {
    const getNeighbors = vi.fn(async () => []);
    const res = await assembleSuggestions(
      { playlist: [{ id: 'x', artist: 'A', title: 'B', sources: {} }], template: '60min', plannedLength: 15 },
      { loadAdjacency: async () => ({ getNeighbors, pairCount: 0, trackCount: 0 }) }
    );
    expect(getNeighbors).not.toHaveBeenCalled();
    expect(res.suggestions.length).toBeGreaterThan(0);
    expect(res.suggestions[0].reasons).toContainEqual(expect.objectContaining({ label: expect.stringMatching(/still resolving/) }));
  });

  it('never returns incomplete tracks from the resolver', async () => {
    const res = await assembleSuggestions(
      { playlist: [last], template: '60min', plannedLength: 15 },
      deps({ resolveTrack: async (a, t) => ({ id: 'half', artist: a, title: t, sources: {}, bpm: 122, camelot: '9A', energy: 5 }) as Track })
    );
    expect(res.suggestions.map((s) => s.track.id)).not.toContain('half');
  });
});

describe('POST /api/suggest', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.adjacency.loadAdjacency.mockRejectedValue(new Error('missing'));
    mocks.resolver.getSimilarTracks.mockResolvedValue([]);
  });

  it('returns ≤10 suggestions with reasons in demo mode', async () => {
    const { POST } = await import('@/app/api/suggest/route');
    const res = await POST(
      new Request('http://x/api/suggest', {
        method: 'POST',
        body: JSON.stringify({ playlist: [last], template: '60min' }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.suggestions.length).toBeLessThanOrEqual(10);
    expect(body.suggestions[0].reasons.length).toBeGreaterThan(0);
  });

  it('rejects a malformed body with 400', async () => {
    const { POST } = await import('@/app/api/suggest/route');
    const res = await POST(new Request('http://x/api/suggest', { method: 'POST', body: 'not json' }));
    expect(res.status).toBe(400);
  });
});

describe('neighbor display names (M1)', () => {
  const key = trackKeyOf('Ben Böhmer', 'Breathing In');
  const neighbors = async () => [{ trackKey: key, count: 3, direction: 'after' as const }];

  it('resolves neighbors with the display names the index recorded, not the normalized key', async () => {
    const resolveTrack = vi.fn(async (artist: string, title: string) => ({ id: 'r1', artist, title, sources: {} }) as Track);
    const suggestNext = vi.fn((_args: unknown) => []);
    await assembleSuggestions(
      { playlist: [last], template: '60min', plannedLength: 15 },
      {
        loadAdjacency: async () => ({
          getNeighbors: neighbors,
          pairCount: 1,
          trackCount: 2,
          nameOf: (k) => (k === key ? { artist: 'Ben Böhmer', title: 'Breathing In' } : undefined),
        }),
        resolveTrack,
        suggestNext,
      }
    );
    expect(resolveTrack).toHaveBeenCalledWith('Ben Böhmer', 'Breathing In');
    const { candidates } = suggestNext.mock.calls[0][0] as { candidates: Track[] };
    expect(candidates[0]).toMatchObject({ id: 'r1', artist: 'Ben Böhmer', title: 'Breathing In' });
  });

  it('falls back to title-cased key parts when the index has no display name', async () => {
    expect(displayFromKey('ben bohmer|breathing in')).toEqual({ artist: 'Ben Bohmer', title: 'Breathing In' });
    const resolveTrack = vi.fn(async (artist: string, title: string) => ({ id: 'r1', artist, title, sources: {} }) as Track);
    await assembleSuggestions(
      { playlist: [last], template: '60min', plannedLength: 15 },
      { loadAdjacency: async () => ({ getNeighbors: neighbors, pairCount: 1, trackCount: 2 }), resolveTrack }
    );
    expect(resolveTrack).toHaveBeenCalledWith('Ben Bohmer', 'Breathing In');
  });

  it("prefers the resolver's canonical names when it returns them", async () => {
    const suggestNext = vi.fn((_args: unknown) => []);
    await assembleSuggestions(
      { playlist: [last], template: '60min', plannedLength: 15 },
      {
        loadAdjacency: async () => ({ getNeighbors: neighbors, pairCount: 1, trackCount: 2 }),
        resolveTrack: async () => ({ id: 'r1', artist: 'Ben Böhmer', title: 'Breathing In (Original Mix)', sources: {} }),
        suggestNext,
      }
    );
    const { candidates } = suggestNext.mock.calls[0][0] as { candidates: Track[] };
    expect(candidates[0]).toMatchObject({ artist: 'Ben Böhmer', title: 'Breathing In (Original Mix)' });
  });
});

describe('time budget (M2)', () => {
  afterEach(() => vi.useRealTimers());
  const never = <T,>() => new Promise<T>(() => {});

  it('caps hung adjacency and similarity lookups per call and still returns demo-pool suggestions', async () => {
    vi.useFakeTimers();
    let res: Awaited<ReturnType<typeof assembleSuggestions>> | undefined;
    const p = assembleSuggestions(
      { playlist: [last], template: '60min', plannedLength: 15 },
      { loadAdjacency: () => never(), getSimilarTracks: () => never(), callTimeoutMs: 50, budgetMs: 1000 }
    ).then((r) => (res = r));
    // well inside the 1s budget: each hung lookup is cut at its 50ms cap
    await vi.advanceTimersByTimeAsync(499);
    vi.useRealTimers();
    await p;
    expect(res).toBeDefined();
    expect(res!.suggestions.length).toBeGreaterThan(0);
  });

  it('drops resolves that miss the overall budget but keeps those that finished', async () => {
    const fast: Track = { id: 'fast', artist: 'Fast', title: 'One', bpm: 122, camelot: '9A', energy: 5, sources: {} };
    const suggestNext = vi.fn((_args: unknown) => []);
    vi.useFakeTimers();
    let done = false;
    const p = assembleSuggestions(
      { playlist: [last], template: '60min', plannedLength: 15 },
      {
        getSimilarTracks: async () => [
          { artist: 'Fast', title: 'One', match: 0.9 },
          { artist: 'Slow', title: 'Two', match: 0.8 },
        ],
        resolveTrack: (artist) => (artist === 'Fast' ? Promise.resolve(fast) : never<Track>()),
        budgetMs: 150,
        suggestNext,
      }
    ).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(599);
    expect(done).toBe(true);
    vi.useRealTimers();
    await p;
    const { candidates } = suggestNext.mock.calls[0][0] as { candidates: Track[] };
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain('fast');
    expect(ids.some((id) => id.startsWith('demo-'))).toBe(true);
    expect(candidates.find((c) => c.artist === 'Slow')).toBeUndefined();
  });
});

describe('loadSuggestDeps demo-adjacency fallback (M3)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('uses the scraped index first, falls back to the demo index on a miss, and exposes display names', async () => {
    const demoOnlyKey = trackKeyOf('Outside Artist', 'Not In Pool');
    const realGet = vi.fn(async (k: string) =>
      k === 'real|hit' ? [{ trackKey: 'real|next', count: 7, direction: 'after' as const }] : []
    );
    const demoGet = vi.fn(async () => [{ trackKey: demoOnlyKey, count: 4, direction: 'after' as const }]);
    mocks.adjacency.loadAdjacency.mockImplementation(async (file?: string) =>
      file === '/seed/adjacency.demo.json'
        ? { getNeighbors: demoGet, pairCount: 1, trackCount: 2 }
        : { getNeighbors: realGet, pairCount: 9, trackCount: 20 }
    );
    mocks.adjacency.readData.mockImplementation((file: string) => ({
      names:
        file === '/seed/adjacency.demo.json'
          ? { [demoOnlyKey]: { artist: 'Outside Artist', title: 'Not In Pool' } }
          : {},
    }));
    mocks.resolver.resolveTrack.mockImplementation(async (artist: string, title: string) => ({
      id: 'resolved-outside',
      artist,
      title,
      bpm: 122,
      camelot: '9A',
      energy: 5,
      sources: {},
    }));
    mocks.resolver.getSimilarTracks.mockResolvedValue([]);

    const deps = await loadSuggestDeps();
    const handle = await deps.loadAdjacency!();
    expect(await handle.getNeighbors('real|hit')).toEqual([{ trackKey: 'real|next', count: 7, direction: 'after' }]);
    expect(demoGet).not.toHaveBeenCalled();
    expect(await handle.getNeighbors(trackKeyOf(last.artist, last.title))).toEqual([
      { trackKey: demoOnlyKey, count: 4, direction: 'after', sample: true },
    ]);
    expect(handle.nameOf?.(demoOnlyKey)).toEqual({ artist: 'Outside Artist', title: 'Not In Pool' });

    const suggestNext = vi.fn((_args: unknown) => []);
    await assembleSuggestions({ playlist: [last], template: '60min', plannedLength: 15 }, { ...deps, suggestNext });
    const args = suggestNext.mock.calls[0][0] as { candidates: Track[]; adjacency: Map<string, number> };
    expect(args.adjacency.get(demoOnlyKey)).toBe(4);
    expect(mocks.resolver.resolveTrack).toHaveBeenCalledWith('Outside Artist', 'Not In Pool');
    expect(args.candidates.find((c) => c.id === 'resolved-outside')).toMatchObject({
      artist: 'Outside Artist',
      title: 'Not In Pool',
    });
  });

  it('a pool track found via the demo index gets the adjacency count without a resolve', async () => {
    const poolKey = trackKeyOf(seed[1].artist, seed[1].title);
    mocks.adjacency.loadAdjacency.mockImplementation(async (file?: string) => ({
      getNeighbors: async () =>
        file === '/seed/adjacency.demo.json' ? [{ trackKey: poolKey, count: 5, direction: 'after' as const }] : [],
      pairCount: 0,
      trackCount: 0,
    }));
    mocks.adjacency.readData.mockReturnValue({ names: {} });
    mocks.resolver.getSimilarTracks.mockResolvedValue([]);
    const deps = await loadSuggestDeps();
    const suggestNext = vi.fn((_args: unknown) => []);
    await assembleSuggestions({ playlist: [last], template: '60min', plannedLength: 15 }, { ...deps, suggestNext });
    const args = suggestNext.mock.calls[0][0] as { candidates: Track[]; adjacency: Map<string, number> };
    expect(args.adjacency.get(poolKey)).toBe(5);
    expect(mocks.resolver.resolveTrack).not.toHaveBeenCalled();
    expect(args.candidates.some((c) => c.id === seed[1].id)).toBe(true);
  });
});

describe('live co-occurrence integration', () => {
  it('route reports digging:true only when an ingest job is queued for the last track', async () => {
    vi.resetModules();
    const ensure = vi.fn();
    vi.doMock('@/lib/adjacency/live', () => ({ ensureNeighborsFor: ensure }));
    const { POST } = await import('@/app/api/suggest/route');
    const call = () =>
      POST(new Request('http://x/api/suggest', { method: 'POST', body: JSON.stringify({ playlist: [last], template: '60min' }) }));
    ensure.mockResolvedValueOnce({ digging: true });
    const a = await (await call()).json();
    expect(a.digging).toBe(true);
    expect(ensure).toHaveBeenCalledWith(last.artist, last.title);
    ensure.mockResolvedValueOnce({ digging: false });
    expect('digging' in (await (await call()).json())).toBe(false);
    ensure.mockRejectedValueOnce(new Error('x'));
    expect((await call()).status).toBe(200);
    vi.doUnmock('@/lib/adjacency/live');
  });

  it('adds a log-scaled "In N DJ sets" bonus only when play_count data exists', async () => {
    const key = trackKeyOf('Outside', 'Neighbor');
    const neighbor: Track = { ...seed[2], id: 'ext-pc', artist: 'Outside', title: 'Neighbor' };
    const run = (playCountOf?: (k: string) => number | undefined) =>
      assembleSuggestions(
        { playlist: [last], template: '60min', plannedLength: 15 },
        {
          loadAdjacency: async () => ({
            getNeighbors: async () => [{ trackKey: key, count: 2, direction: 'after' as const }],
            pairCount: 1,
            trackCount: 1,
            playCountOf,
          }),
          resolveTrack: async () => neighbor,
          suggestNext: (a) => [{ track: neighbor, score: 0.5, reasons: [] }].slice(0, a.adjacency ? 1 : 0),
        }
      );
    const without = (await run()).suggestions[0];
    const withPc = (await run((k) => (k === key ? 100 : undefined))).suggestions[0];
    expect(without.reasons.some((r) => /DJ set/.test(r.label))).toBe(false);
    expect(withPc.reasons.some((r) => r.label === 'In 100 DJ sets')).toBe(true);
    expect(withPc.score).toBeGreaterThan(without.score);
    expect(withPc.score - without.score).toBeLessThanOrEqual(0.05);
  });
});
