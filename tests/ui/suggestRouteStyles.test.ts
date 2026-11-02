// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeTrack } from '@/components/trackSanitize';
import { assembleSuggestions, MAX_STYLES_FILL_PER_REQUEST, MAX_STYLES_QUEUED_PER_REQUEST, type SuggestDeps } from '@/app/api/suggest/assemble';
import { demoTracks } from '@/lib/demo';
import { trackKeyOf, type Track } from '@/types/track';

const mocks = vi.hoisted(() => ({
  resolver: { resolveWithStatus: vi.fn(), getSimilarTracks: vi.fn(), queueStyles: vi.fn() },
  adjacency: { loadAdjacency: vi.fn(), readData: vi.fn(), ADJACENCY_PATH: '/index/adjacency.json', DEMO_ADJACENCY_PATH: '/seed/adjacency.demo.json' },
  cache: { getEntry: vi.fn(), getEntries: vi.fn(), STYLES_RECHECK_MS: 7 * 24 * 3600_000 },
}));
vi.mock('@/lib/resolver', () => mocks.resolver);
vi.mock('@/lib/adjacency', () => mocks.adjacency);
vi.mock('@/lib/metadataCache', () => mocks.cache);
vi.mock('@/lib/adjacency/live', () => ({ ensureNeighborsFor: async () => ({ digging: false }) }));

const seed = demoTracks();
const keyOf = (t: { artist: string; title: string }) => trackKeyOf(t.artist, t.title);
const strip = (t: Track): Track => {
  const { styles: _s, ...rest } = t as Track & { styles?: string[] };
  return rest as Track;
};
// complete non-demo tracks: demo essentials under new names, no styles on the client side
const own = (n: number, from = 0): Track[] =>
  seed.slice(from, from + n).map((t, i) => strip({ ...t, id: `own-${from + i}`, artist: `Own Artist ${from + i}`, title: `Own Title ${from + i}`, sources: {} }));

type Entry = { fields: Partial<Track>; sources: Record<string, string>; resolvedAt: number; attempts: number; stylesCheckedAt?: number };
const entryOf = (t: Track, styles?: string[]): Entry => ({
  fields: { bpm: t.bpm, camelot: t.camelot, energy: t.energy, danceability: t.danceability, ...(styles ? { styles } : {}) },
  sources: styles ? { styles: 'lastfm-tags' } : {},
  resolvedAt: Date.now(),
  attempts: 1,
});

describe('C1: styles reach the engine in the real app', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.adjacency.loadAdjacency.mockRejectedValue(new Error('missing'));
    mocks.resolver.getSimilarTracks.mockResolvedValue([]);
    mocks.resolver.queueStyles.mockReturnValue(true);
  });

  it('sanitizeTrack keeps a bounded styles list (route whitelist)', () => {
    const t = sanitizeTrack({ id: 'a', artist: 'A', title: 'T', styles: ['techno', 'x'.repeat(101), 5, '', ...Array(20).fill('house')] });
    expect(t!.styles).toEqual(['techno', ...Array(9).fill('house')]);
    expect(sanitizeTrack({ id: 'a', artist: 'A', title: 'T', styles: 'techno' })!.styles).toBeUndefined();
  });

  it('POST: an untagged set whose tracks have cached styles yields style reasons; crate items get styles from the cache', async () => {
    const set = own(3, 0);
    const crate = own(12, 3);
    const cache = new Map<string, Entry>([...set, ...crate].map((t) => [keyOf(t), entryOf(t, ['melodic-house'])]));
    mocks.cache.getEntries.mockImplementation((keys: string[]) => new Map(keys.flatMap((k) => (cache.has(k) ? [[k, cache.get(k)!] as const] : []))));
    mocks.cache.getEntry.mockImplementation((k: string) => cache.get(k));
    const { POST } = await import('@/app/api/suggest/route');
    const res = await POST(new Request('http://x/api/suggest', { method: 'POST', body: JSON.stringify({ playlist: set, template: '60min', crate }) }));
    const body = (await res.json()) as { suggestions: Array<{ track: Track; reasons: Array<{ kind: string; label: string }> }>; crateKnown: Array<{ key: string; styles?: string[] }> };
    const styled = body.suggestions.filter((s) => s.reasons.some((r) => r.kind === 'style' && /melodic house/.test(r.label)));
    expect(styled.length).toBeGreaterThan(0);
    expect(body.crateKnown.length).toBe(crate.length);
    expect(body.crateKnown.every((k) => k.styles?.[0] === 'melodic-house')).toBe(true);
    // one snapshot for set + crate
    expect(mocks.cache.getEntries).toHaveBeenCalledTimes(1);
    expect(mocks.cache.getEntries.mock.calls[0][0]).toEqual(expect.arrayContaining([...set, ...crate].map(keyOf)));
  });

  it('queues styles (≤ cap per request) for complete set and crate tracks the cache has no styles for, newest set track first', async () => {
    const set = own(3, 0);
    const crate = own(10, 3);
    const cache = new Map<string, Entry>([...set, ...crate].map((t) => [keyOf(t), entryOf(t)]));
    cache.set(keyOf(crate[0]), { ...entryOf(crate[0]), stylesCheckedAt: Date.now() }); // settled "no tags" marker
    cache.set(keyOf(crate[1]), entryOf(crate[1], ['techno'])); // already tagged
    const queueStyles = vi.fn((_t: Track) => true);
    await assembleSuggestions(
      { playlist: set, template: '60min', plannedLength: 15, crate },
      { getCachedEntries: (keys) => new Map(keys.flatMap((k) => (cache.has(k) ? [[k, cache.get(k)!] as const] : []))), queueStyles },
    );
    expect(MAX_STYLES_QUEUED_PER_REQUEST).toBe(4);
    const queued = queueStyles.mock.calls.map(([t]) => keyOf(t));
    expect(queued).toEqual([set[2], set[1], set[0], crate[2]].map(keyOf));
  });

  it('a queue refusal (already queued, Last.fm off) does not use up the per-request cap', async () => {
    const crate = own(8, 3);
    const cache = new Map<string, Entry>(crate.map((t) => [keyOf(t), entryOf(t)]));
    const queueStyles = vi.fn((t: Track) => keyOf(t) !== keyOf(crate[0]));
    const deps: SuggestDeps = { getCachedEntries: (keys) => new Map(keys.flatMap((k) => (cache.has(k) ? [[k, cache.get(k)!] as const] : []))), queueStyles };
    await assembleSuggestions({ playlist: [], template: '60min', plannedLength: 15, crate }, deps);
    expect(queueStyles.mock.calls.filter(([t], i) => queueStyles.mock.results[i].value === true)).toHaveLength(4);
    expect(queueStyles).toHaveBeenCalledTimes(5);
  });

  it('fill mode: up to 25 per request while the styles queue is short and Last.fm has headroom; back to 4 when it closes', async () => {
    expect(MAX_STYLES_FILL_PER_REQUEST).toBe(25);
    const crate = own(40, 3);
    const cache = new Map<string, Entry>(crate.map((t) => [keyOf(t), entryOf(t)]));
    const getCachedEntries: SuggestDeps['getCachedEntries'] = (keys) => new Map(keys.flatMap((k) => (cache.has(k) ? [[k, cache.get(k)!] as const] : [])));
    const q1 = vi.fn((_t: Track) => true);
    await assembleSuggestions({ playlist: [], template: '60min', plannedLength: 15, crate }, { getCachedEntries, queueStyles: q1, stylesFillOpen: () => true });
    expect(q1).toHaveBeenCalledTimes(25);
    let n = 0;
    const q2 = vi.fn((_t: Track) => (n++, true));
    await assembleSuggestions({ playlist: [], template: '60min', plannedLength: 15, crate }, { getCachedEntries, queueStyles: q2, stylesFillOpen: () => n < 10 });
    expect(q2).toHaveBeenCalledTimes(10);
    const q3 = vi.fn((_t: Track) => true);
    await assembleSuggestions({ playlist: [], template: '60min', plannedLength: 15, crate }, { getCachedEntries, queueStyles: q3, stylesFillOpen: () => false });
    expect(q3).toHaveBeenCalledTimes(4);
  });

  it('loadSuggestDeps opens fill only while the styles queue < 50 and Last.fm headroom >= 50%', async () => {
    const len = vi.fn(() => 10);
    (mocks.resolver as Record<string, unknown>).stylesQueueLength = len;
    const breaker = await import('@/lib/search/breaker');
    const head = vi.spyOn(breaker, 'budgetHeadroom');
    const { loadSuggestDeps } = await import('@/app/api/suggest/assemble');
    const deps = await loadSuggestDeps();
    head.mockReturnValue(0.8);
    expect(await deps.stylesFillOpen!()).toBe(true);
    head.mockReturnValue(0.4);
    expect(await deps.stylesFillOpen!()).toBe(false);
    head.mockReturnValue(0.8);
    len.mockReturnValue(50);
    expect(await deps.stylesFillOpen!()).toBe(false);
    head.mockRestore();
  });
});
