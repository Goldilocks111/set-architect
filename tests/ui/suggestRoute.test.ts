import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { assembleSuggestions, displayFromKey, loadSuggestDeps, resetCrateBackground, type SuggestDeps } from '@/app/api/suggest/assemble';
import { demoTracks } from '@/lib/demo';
import { trackKeyOf, type Track } from '@/types/track';

const mocks = vi.hoisted(() => ({
  resolver: {
    searchTracks: vi.fn(),
    resolveTrack: vi.fn(),
    resolveWithStatus: vi.fn(),
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
    expect(resolveTrack).toHaveBeenCalledWith('Ben Böhmer', 'Breathing In', expect.anything());
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
    expect(resolveTrack).toHaveBeenCalledWith('Ben Bohmer', 'Breathing In', expect.anything());
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
    mocks.resolver.resolveWithStatus.mockImplementation(async (artist: string, title: string) => ({
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
    expect(mocks.resolver.resolveWithStatus).toHaveBeenCalledWith('Outside Artist', 'Not In Pool', expect.anything());
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
    expect(mocks.resolver.resolveWithStatus).not.toHaveBeenCalled();
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

describe('crate as the primary candidate pool', () => {
  const nonDemo = () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  };
  afterEach(() => vi.unstubAllEnvs());

  const full = { bpm: 124, camelot: '8A', energy: 6, danceability: 0.7 };
  const crateTrack = (n: number, extra: Partial<Track> = {}): Track => ({
    id: `crate-${n}`,
    artist: `Crate Artist ${n}`,
    title: `Crate Song ${n}`,
    sources: {},
    ...extra,
  });
  const capture = () => {
    const suggestNext = vi.fn((_a: unknown) => []);
    const candidates = () => (suggestNext.mock.calls[0][0] as { candidates: Track[] }).candidates;
    return { suggestNext, candidates };
  };
  const input = (crate: Track[]) => ({ playlist: [last], template: '60min' as const, plannedLength: 15, crate });

  it('uses complete crate tracks as the pool and leaves the demo crate out once there are 30 (non-demo)', async () => {
    nonDemo();
    const { suggestNext, candidates } = capture();
    await assembleSuggestions(input(Array.from({ length: 30 }, (_, i) => crateTrack(i, full))), { suggestNext });
    const ids = candidates().map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['crate-1', 'crate-29']));
    expect(candidates().some((c) => c.sources.bpm === 'demo-seed')).toBe(false);
  });

  it('a non-demo user with fewer than 30 complete crate tracks gets the starter (demo) crate, never an empty Openers panel', async () => {
    nonDemo();
    const a = capture();
    await assembleSuggestions(input([crateTrack(1, full)]), { suggestNext: a.suggestNext });
    expect(a.candidates().some((c) => c.sources.bpm === 'demo-seed')).toBe(true);
    expect(a.candidates().some((c) => c.id === 'crate-1')).toBe(true);
    const res = await assembleSuggestions({ playlist: [], template: '60min', plannedLength: 15, crate: [] }, {});
    expect(res.suggestions.length).toBe(10);
  });

  it('demo crate is used only in demo mode with fewer than 30 complete crate tracks', async () => {
    const small = Array.from({ length: 29 }, (_, i) => crateTrack(i, full));
    const a = capture();
    await assembleSuggestions(input(small), { suggestNext: a.suggestNext }); // demo mode (no supabase env)
    expect(a.candidates().some((c) => c.sources.bpm === 'demo-seed')).toBe(true);
    expect(a.candidates().some((c) => c.id === 'crate-0')).toBe(true);

    const enough = Array.from({ length: 30 }, (_, i) => crateTrack(i, full));
    const b = capture();
    await assembleSuggestions(input(enough), { suggestNext: b.suggestNext });
    expect(b.candidates().some((c) => c.sources.bpm === 'demo-seed')).toBe(false);

    // incomplete tracks do not count toward the 30
    const padded = [...small, ...Array.from({ length: 10 }, (_, i) => crateTrack(100 + i))];
    const c = capture();
    await assembleSuggestions(input(padded), { suggestNext: c.suggestNext });
    expect(c.candidates().some((x) => x.sources.bpm === 'demo-seed')).toBe(true);
  });

  it('enriches crate tracks from the metadata cache only: cache wins, no provider calls, incomplete stay out', async () => {
    nonDemo();
    const { suggestNext, candidates } = capture();
    const resolveTrack = vi.fn(async () => null as unknown as Track);
    const getSimilarTracks = vi.fn(async () => []);
    const entries: Record<string, { fields: Partial<Track>; sources?: Record<string, string> }> = {
      [trackKeyOf('Crate Artist 1', 'Crate Song 1')]: { fields: { ...full, bpm: 128 }, sources: { bpm: 'manual' } },
      [trackKeyOf('Crate Artist 2', 'Crate Song 2')]: { fields: { bpm: 120 } }, // still incomplete
    };
    const getCachedEntry = vi.fn((k: string) => entries[k]);
    await assembleSuggestions(
      input([crateTrack(1, { bpm: 100 }), crateTrack(2), crateTrack(3), crateTrack(4, full)]),
      { suggestNext, resolveTrack, getCachedEntry, getSimilarTracks }
    );
    const byId = new Map(candidates().map((c) => [c.id, c]));
    expect(byId.get('crate-1')).toMatchObject({ ...full, bpm: 128 });
    expect(byId.get('crate-1')!.sources.bpm).toBe('manual');
    expect(byId.has('crate-2')).toBe(false);
    expect(byId.has('crate-3')).toBe(false);
    expect(byId.get('crate-4')).toMatchObject(full); // client-supplied essentials may be used directly
    expect(resolveTrack).not.toHaveBeenCalled();
  });

  it('crate tracks already in the set are not suggested', async () => {
    nonDemo();
    const { suggestNext, candidates } = capture();
    await assembleSuggestions(
      { playlist: [last, crateTrack(1, full)], template: '60min', plannedLength: 15, crate: [crateTrack(1, full), crateTrack(2, full)] },
      { suggestNext }
    );
    const ids = candidates().map((c) => c.id);
    expect(ids).toContain('crate-2');
    expect(ids).not.toContain('crate-1');
  });

  it('tiny crate falls back: neighbours still appear and the hint-worthy empty pool does not break scoring', async () => {
    nonDemo();
    const neighborKey = trackKeyOf('Outside', 'Neighbor');
    const { suggestNext, candidates } = capture();
    await assembleSuggestions(input([crateTrack(1, full)]), {
      suggestNext,
      loadAdjacency: async () => ({
        getNeighbors: async () => [{ trackKey: neighborKey, count: 3, direction: 'after' as const }],
        pairCount: 1,
        trackCount: 2,
      }),
      getCachedEntry: (k) => (k === neighborKey ? { fields: { ...full } } : undefined),
    });
    const ids = candidates().map((c) => c.id);
    expect(ids).toContain(`cache-${neighborKey}`);
    expect(ids).toContain('crate-1');
  });

  it('tiny crate falls back to the demo crate in demo mode', async () => {
    const res = await assembleSuggestions(input([crateTrack(1, full)]), {});
    expect(res.suggestions.length).toBeGreaterThan(0);
  });
});

describe('POST /api/suggest crate validation', () => {
  const post = async (body: unknown) => {
    vi.resetModules();
    const assemble = vi.fn(async () => ({ suggestions: [] }));
    vi.doMock('@/app/api/suggest/assemble', () => ({ assembleSuggestions: assemble, loadSuggestDeps: async () => ({}) }));
    vi.doMock('@/lib/adjacency/live', () => ({ ensureNeighborsFor: async () => ({ digging: false }) }));
    const { POST } = await import('@/app/api/suggest/route');
    const res = await POST(new Request('http://x/api/suggest', { method: 'POST', body: JSON.stringify(body) }));
    vi.doUnmock('@/app/api/suggest/assemble');
    vi.doUnmock('@/lib/adjacency/live');
    const crate = ((assemble.mock.calls[0] as unknown[] | undefined)?.[0] as { crate?: Array<Record<string, unknown>> } | undefined)?.crate;
    return { res, crate };
  };
  const row = (n: number, extra: Record<string, unknown> = {}) => ({ id: `c${n}`, artist: `A${n}`, title: `T${n}`, sources: {}, ...extra });

  it('payload capped at 600 items', async () => {
    const { res, crate } = await post({ playlist: [], template: '60min', crate: Array.from({ length: 700 }, (_, i) => row(i)) });
    expect(res.status).toBe(200);
    expect(crate).toHaveLength(600);
  });

  it('drops invalid items and strings over 200 chars; sanitises ranges and styles', async () => {
    const { crate } = await post({
      playlist: [],
      template: '60min',
      crate: [
        row(1, { bpm: 124, camelot: '8A', energy: 6, danceability: 0.7, styles: ['techno', 'x'.repeat(201), 5] }),
        row(2, { artist: 'x'.repeat(201) }),
        row(3, { title: 'y'.repeat(201) }),
        row(4, { id: 'z'.repeat(201) }),
        { id: 'c5' },
        'nope',
        row(6, { bpm: 9999, camelot: 'ZZ' }),
      ],
    });
    expect(crate!.map((c) => c.id)).toEqual(['c1', 'c6']);
    expect(crate![0]).toMatchObject({ bpm: 124, camelot: '8A', energy: 6, danceability: 0.7, styles: ['techno'] });
    expect(crate![1].bpm).toBeUndefined();
    expect(crate![1].camelot).toBeUndefined();
  });

  it('a missing or non-array crate is simply empty; a crate is not required', async () => {
    expect((await post({ playlist: [], template: '60min' })).crate).toEqual([]);
    expect((await post({ playlist: [], template: '60min', crate: 'x' })).crate).toEqual([]);
  });
});

describe('crate background fill and known report', () => {
  const full = { bpm: 124, camelot: '8A', energy: 6, danceability: 0.7 };
  const ct = (n: number, extra: Partial<Track> = {}): Track => ({ id: `c${n}`, artist: `Crate Artist ${n}`, title: `Crate Song ${n}`, sources: {}, ...extra });
  const base = (crate: Track[]) => ({ playlist: [last], template: '60min' as const, plannedLength: 15, crate });
  beforeEach(() => resetCrateBackground());

  it('starts at most 2 incomplete crate items (the first = newest), without awaiting them', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const backgroundResolve = vi.fn((_a: string, _t: string) => gate);
    const t0 = Date.now();
    await assembleSuggestions(base([ct(1, full), ct(2), ct(3), ct(4)]), { backgroundResolve });
    expect(Date.now() - t0).toBeLessThan(500); // returned while the fills are still pending
    expect(backgroundResolve.mock.calls.map((c) => c[1])).toEqual(['Crate Song 2', 'Crate Song 3']);
    release();
  });

  it('dedupes per key while a fill is running, then lets the next request continue down the list', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const backgroundResolve = vi.fn((_a: string, _t: string) => gate);
    await assembleSuggestions(base([ct(2), ct(3), ct(4)]), { backgroundResolve });
    await assembleSuggestions(base([ct(2), ct(3), ct(4)]), { backgroundResolve });
    expect(backgroundResolve.mock.calls.map((c) => c[1])).toEqual(['Crate Song 2', 'Crate Song 3', 'Crate Song 4']);
    release();
    await new Promise((r) => setTimeout(r, 0));
    await assembleSuggestions(base([ct(2)]), { backgroundResolve });
    expect(backgroundResolve).toHaveBeenCalledTimes(4);
  });

  it('skips items the cache already settled so they cannot hog the slots; a rejected fill is swallowed', async () => {
    const settled = { fields: { bpm: 120 }, reason: 'not-found', resolvedAt: Date.now() };
    const getCachedEntries = (keys: string[]) => new Map(keys.filter((k) => k === trackKeyOf('Crate Artist 1', 'Crate Song 1')).map((k) => [k, settled]));
    const backgroundResolve = vi.fn(async (_a: string, _t: string): Promise<unknown> => { throw new Error('boom'); });
    const res = await assembleSuggestions(base([ct(1), ct(2), ct(3), ct(4)]), { backgroundResolve, getCachedEntries });
    expect(res.suggestions.length).toBeGreaterThan(0);
    expect(backgroundResolve.mock.calls.map((c) => c[1])).toEqual(['Crate Song 2', 'Crate Song 3']);
  });

  it('reports crateKnown for items the cache has complete, and uses one snapshot lookup', async () => {
    const k1 = trackKeyOf('Crate Artist 1', 'Crate Song 1');
    const getCachedEntries = vi.fn((keys: string[]) => new Map(keys.filter((k) => k === k1).map((k) => [k, { fields: { ...full, bpm: 128 } }])));
    const getCachedEntry = vi.fn();
    const res = await assembleSuggestions(base([ct(1), ct(2, full), ct(3)]), { getCachedEntries, getCachedEntry });
    expect(res.crateKnown).toEqual([{ key: k1, bpm: 128, camelot: '8A', energy: 6, danceability: 0.7 }]);
    expect(getCachedEntries).toHaveBeenCalledTimes(1);
    expect(getCachedEntry).not.toHaveBeenCalled();
  });

  it('loadSuggestDeps: the background fill needs Spotify and Deezer budget and never asks iTunes', async () => {
    const breaker = await import('@/lib/search/breaker');
    breaker.resetBudgets();
    mocks.resolver.resolveWithStatus.mockResolvedValue({});
    const deps = await loadSuggestDeps();
    await deps.backgroundResolve!('A', 'B');
    expect(mocks.resolver.resolveWithStatus).toHaveBeenCalledWith('A', 'B', { without: ['itunes'], retryWithout: ['itunes'] });
    mocks.resolver.resolveWithStatus.mockClear();
    for (let i = 0; i < 30; i++) breaker.takeBudget('spotify', { app: true }); // app quota spent
    await deps.backgroundResolve!('A', 'C');
    expect(mocks.resolver.resolveWithStatus).not.toHaveBeenCalled();
    breaker.resetBudgets();
  });
});

describe('crate scale', () => {
  it('payload capped and request < 300 ms with a real 2,000-entry cache and a 600-item crate', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const prev = process.env.SETARCHITECT_DATA_DIR;
    process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-scale-'));
    try {
      vi.resetModules();
      const { dataDir } = await import('@/lib/dataDir');
      const cache = Object.fromEntries(
        Array.from({ length: 2000 }, (_, i) => [
          trackKeyOf(`Artist ${i}`, `Song ${i}`),
          { fields: { bpm: 118 + (i % 14), camelot: `${(i % 12) + 1}A`, energy: 1 + (i % 10), danceability: 0.6 }, sources: { bpm: 'manual' }, resolvedAt: 1, attempts: 1 },
        ])
      );
      fs.writeFileSync(dataDir('index', 'metadata.json'), JSON.stringify(cache));
      vi.doMock('@/lib/resolver', () => ({ ...mocks.resolver, resolveWithStatus: vi.fn(async () => ({})), getSimilarTracks: async () => [] }));
      vi.doMock('@/lib/adjacency', () => ({ ...mocks.adjacency, loadAdjacency: async () => { throw new Error('none'); } }));
      const { assembleSuggestions: assemble, loadSuggestDeps: load } = await import('@/app/api/suggest/assemble');
      const deps = await load();
      const crate: Track[] = Array.from({ length: 600 }, (_, i) => ({ id: `c${i}`, artist: `Artist ${i}`, title: `Song ${i}`, sources: {} }));
      const t0 = performance.now();
      const res = await assemble({ playlist: [last], template: '60min', plannedLength: 15, crate }, deps);
      const ms = performance.now() - t0;
      expect(res.suggestions.length).toBeGreaterThan(0);
      expect(res.crateKnown).toHaveLength(600);
      expect(ms).toBeLessThan(300);
    } finally {
      vi.doUnmock('@/lib/resolver');
      vi.doUnmock('@/lib/adjacency');
      if (prev === undefined) delete process.env.SETARCHITECT_DATA_DIR;
      else process.env.SETARCHITECT_DATA_DIR = prev;
    }
  });

  it('a 2000-item crate body is capped to 600 before assembly', async () => {
    vi.resetModules();
    const assemble = vi.fn(async () => ({ suggestions: [], crateKnown: [] }));
    vi.doMock('@/app/api/suggest/assemble', () => ({ assembleSuggestions: assemble, loadSuggestDeps: async () => ({}) }));
    vi.doMock('@/lib/adjacency/live', () => ({ ensureNeighborsFor: async () => ({ digging: false }) }));
    const { POST } = await import('@/app/api/suggest/route');
    const crate = Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, artist: `A${i}`, title: `T${i}`, sources: {} }));
    await POST(new Request('http://x/api/suggest', { method: 'POST', body: JSON.stringify({ playlist: [], template: '60min', crate }) }));
    expect((assemble.mock.calls[0] as unknown as [{ crate: unknown[] }])[0].crate).toHaveLength(600);
    vi.doUnmock('@/app/api/suggest/assemble');
    vi.doUnmock('@/lib/adjacency/live');
  });
});
