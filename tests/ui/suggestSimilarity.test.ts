import { describe, expect, it, vi } from 'vitest';
import { assembleSuggestions } from '@/app/api/suggest/assemble';
import { trackKeyOf, type Suggestion, type Track } from '@/types/track';

vi.mock('@/lib/resolver', () => ({ searchTracks: vi.fn(), resolveTrack: vi.fn(), resolveWithStatus: vi.fn(), getSimilarTracks: vi.fn() }));
vi.mock('@/lib/adjacency', () => ({ loadAdjacency: vi.fn(), readData: vi.fn(), ADJACENCY_PATH: '/x', DEMO_ADJACENCY_PATH: '/y' }));

const full = { bpm: 124, camelot: '8A', energy: 5, danceability: 0.6 };
const tr = (id: string, o: Partial<Track> = {}): Track => ({ id, artist: `Artist ${id}`, title: `Title ${id}`, sources: {}, ...full, ...o });
const input = (playlist: Track[]) => ({ playlist, arc: { minutes: 60, shape: 'build' as const } });
const never = <T,>() => new Promise<T>(() => {});

describe('similarity from the last 3 complete set tracks', () => {
  it('queries the last 3 complete tracks (skipping incomplete), scales matches 1.0/0.6/0.3 newest first, merges by max', async () => {
    const set = [tr('s0'), tr('s1'), tr('s2'), tr('inc', { bpm: undefined }), tr('s3')];
    const calls: string[] = [];
    const bySeed: Record<string, Array<{ artist: string; title: string; match: number }>> = {
      'Title s3': [{ artist: 'X', title: 'Only Newest', match: 0.5 }, { artist: 'X', title: 'Shared', match: 0.4 }],
      'Title s2': [{ artist: 'X', title: 'Shared', match: 1 }, { artist: 'X', title: 'Middle', match: 0.5 }],
      'Title s1': [{ artist: 'X', title: 'Oldest', match: 1 }],
    };
    const suggestNext = vi.fn((_a: unknown) => [] as Suggestion[]);
    await assembleSuggestions(input(set), {
      getSimilarTracks: async (_artist, title) => {
        calls.push(title);
        return bySeed[title] ?? [];
      },
      suggestNext,
    });
    expect(calls.sort()).toEqual(['Title s1', 'Title s2', 'Title s3']);
    const { similarity } = suggestNext.mock.calls[0][0] as { similarity: Map<string, number> };
    expect(similarity.get(trackKeyOf('X', 'Only Newest'))).toBeCloseTo(0.5);
    expect(similarity.get(trackKeyOf('X', 'Shared'))).toBeCloseTo(0.6); // max(0.4 × 1.0, 1 × 0.6)
    expect(similarity.get(trackKeyOf('X', 'Middle'))).toBeCloseTo(0.3);
    expect(similarity.get(trackKeyOf('X', 'Oldest'))).toBeCloseTo(0.3);
  });

  it('runs the lookups in parallel, each under the per-call cap: one hung seed does not drop the others', async () => {
    vi.useFakeTimers();
    try {
      const suggestNext = vi.fn((_a: unknown) => [] as Suggestion[]);
      let done = false;
      const p = assembleSuggestions(input([tr('a'), tr('b'), tr('c')]), {
        getSimilarTracks: (_artist, title) =>
          title === 'Title b' ? never() : Promise.resolve([{ artist: 'Y', title: `From ${title}`, match: 1 }]),
        callTimeoutMs: 50,
        budgetMs: 1000,
        suggestNext,
      }).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(60); // one cap, not three in sequence
      expect(done).toBe(true);
      await p;
      const { similarity } = suggestNext.mock.calls[0][0] as { similarity: Map<string, number> };
      expect(similarity.get(trackKeyOf('Y', 'From Title c'))).toBeCloseTo(1);
      expect(similarity.get(trackKeyOf('Y', 'From Title a'))).toBeCloseTo(0.3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('play-count bonus keeps compliance tiers', () => {
  it('a bonused non-compliant suggestion never overtakes a compliant one', async () => {
    const good = tr('good', { artist: 'Good', title: 'Track' });
    const bad = tr('bad', { artist: 'Bad', title: 'Track' });
    const res = await assembleSuggestions(input([tr('last')]), {
      loadAdjacency: async () => ({
        getNeighbors: async () => [],
        pairCount: 0,
        trackCount: 0,
        playCountOf: (k) => (k === trackKeyOf('Bad', 'Track') ? 1000 : undefined),
      }),
      suggestNext: () => [
        { track: good, score: 0.5, reasons: [], compliant: true },
        { track: bad, score: 0.49, reasons: [], compliant: false },
      ],
    });
    expect(res.suggestions.map((s) => s.track.id)).toEqual(['good', 'bad']);
    expect(res.suggestions[1].score).toBeGreaterThan(res.suggestions[0].score);
  });
});
