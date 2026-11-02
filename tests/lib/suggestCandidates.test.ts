// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, mockFetch } from '../sources/helpers';

const analysePreview = vi.fn();
vi.mock('@/lib/analysis/previewAnalysis', () => ({ analysePreview: (...a: unknown[]) => analysePreview(...a), ANALYSIS_TIMEOUT_MS: 5000 }));

import {
  assembleSuggestions,
  loadSuggestDeps,
  MAX_CANDIDATE_RESOLVES,
  resetCandidateLimiter,
  type SuggestDeps,
} from '@/app/api/suggest/assemble';
import { resolveWithStatus } from '@/lib/resolver';
import { getEntry, putResolved } from '@/lib/metadataCache';
import { resetBreakers } from '@/lib/search/breaker';
import { clearSearchCache } from '@/lib/search/cache';
import { resetProviderBudgets } from '@/lib/search/merge';
import { configureMusicBrainzLimiter } from '@/lib/sources/musicbrainz';
import { demoTracks } from '@/lib/demo';
import { trackKeyOf, type Track } from '@/types/track';

const last = demoTracks()[0];
const input = { playlist: [last], arc: { minutes: 60, shape: 'build' as const } };
const deezerHit = (over = {}) => ({ id: 1, title: 'Neighbor', rank: 5, artist: { name: 'Outside' }, ...over });

beforeEach(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-cand-'));
  clearSearchCache();
  resetProviderBudgets();
  resetBreakers();
  resetCandidateLimiter();
  configureMusicBrainzLimiter(0);
  analysePreview.mockReset();
  for (const k of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'GETSONGBPM_API_KEY', 'SOUNDSTAT_API_KEY', 'YOUTUBE_API_KEY', 'LASTFM_API_KEY'])
    vi.stubEnv(k, '');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Real resolver + metadata cache; only the similarity source is injected. */
async function realDeps(similar: Array<{ artist: string; title: string; match: number }>): Promise<SuggestDeps> {
  const deps = await loadSuggestDeps();
  return { ...deps, loadAdjacency: undefined, getSimilarTracks: async () => similar };
}

describe('suggest candidates go through the cached resolver', () => {
  it('a resolved candidate is written to the metadata cache; the next refresh makes zero adapter calls', async () => {
    const fetchFn = mockFetch([
      ['api.deezer.com', () => json({ data: [deezerHit({ preview: 'dz', bpm: 124 })] })],
      ['itunes.apple.com', () => json({ results: [] })],
      ['musicbrainz.org', () => json({ recordings: [] })],
    ]);
    analysePreview.mockResolvedValue({ bpm: 124, camelot: '8A', energy: 6, danceability: 0.7 });
    const deps = await realDeps([{ artist: 'Outside', title: 'Neighbor', match: 0.9 }]);
    const suggestNext = vi.fn((_a: unknown) => []);
    await assembleSuggestions(input, { ...deps, suggestNext });
    const entry = getEntry(trackKeyOf('Outside', 'Neighbor'));
    expect(entry?.fields).toMatchObject({ bpm: 124, camelot: '8A', energy: 6, danceability: 0.7 });
    expect(fetchFn).toHaveBeenCalled();

    fetchFn.mockClear();
    await assembleSuggestions(input, { ...deps, suggestNext });
    expect(fetchFn).not.toHaveBeenCalled();
    const { candidates } = suggestNext.mock.calls[1][0] as { candidates: Track[] };
    const hit = candidates.find((c) => c.artist === 'Outside')!;
    expect(hit).toMatchObject({ bpm: 124, danceability: 0.7 });
    // provenance survives the cache hit
    expect(hit.sources.danceability).toBe('preview-analysis');
  });

  it('a negatively cached (permanent) candidate costs zero adapter calls on later refreshes', async () => {
    putResolved(trackKeyOf('Outside', 'Neighbor'), {
      id: 'x', artist: 'Outside', title: 'Neighbor', sources: {}, unresolved: { reason: 'not-found', missing: ['bpm', 'camelot', 'energy', 'danceability'] },
    });
    const fetchFn = mockFetch([]);
    const deps = await realDeps([{ artist: 'Outside', title: 'Neighbor', match: 0.9 }]);
    await assembleSuggestions(input, deps);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('the budget aborts the adapter chain: no adapter call starts after the deadline', async () => {
    vi.useFakeTimers();
    const fetchFn = mockFetch([
      ['api.deezer.com', () => new Promise<Response>(() => {})], // hangs until its 4 s adapter timeout
      ['itunes.apple.com', () => json({ results: [] })],
      ['musicbrainz.org', () => json({ recordings: [] })],
    ]);
    const deps = await realDeps([{ artist: 'Outside', title: 'Neighbor', match: 0.9 }]);
    const p = assembleSuggestions(input, { ...deps, budgetMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    await p;
    const atDeadline = fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchFn.mock.calls.length).toBe(atDeadline);
    const hosts = fetchFn.mock.calls.map((c) => new URL(String(c[0])).hostname);
    expect(hosts).not.toContain('itunes.apple.com');
    // the timed-out candidate is cached as retryable with a retryAt, so the next refresh is served from cache
    const e = getEntry(trackKeyOf('Outside', 'Neighbor'));
    expect(e?.reason).toBe('timeout');
    expect(e?.retryAt).toBeTypeOf('number');
  });
});

describe('candidate resolve limits', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ artist: `Art${i}`, title: `T${i}`, match: 1 - i / 100 }));

  it(`resolves at most 2 at a time and at most MAX_CANDIDATE_RESOLVES per refresh`, async () => {
    let active = 0;
    let maxActive = 0;
    const resolveTrack = vi.fn(async (artist: string, title: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { id: `r-${title}`, artist, title, sources: {} } as Track;
    });
    await assembleSuggestions(input, { getSimilarTracks: async () => many(8), resolveTrack });
    expect(maxActive).toBe(2);
    expect(resolveTrack).toHaveBeenCalledTimes(MAX_CANDIDATE_RESOLVES);
    expect(MAX_CANDIDATE_RESOLVES).toBeLessThanOrEqual(4);
  });

  it('the cap holds across overlapping refreshes, and a resolve gets the signal aborted at the budget', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const signals: AbortSignal[] = [];
    const resolveTrack = vi.fn((_a: string, _t: string, opts?: { signal?: AbortSignal; budgetMs?: number }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      signals.push(opts!.signal!);
      expect(opts!.budgetMs).toBeLessThanOrEqual(1000);
      return new Promise<Track>((_, reject) =>
        opts!.signal!.addEventListener('abort', () => {
          active--;
          reject(new Error('aborted'));
        })
      );
    });
    const a = assembleSuggestions(input, { getSimilarTracks: async () => many(4), resolveTrack, budgetMs: 1000 });
    const b = assembleSuggestions(input, { getSimilarTracks: async () => many(4).map((x) => ({ ...x, title: `${x.title}b` })), resolveTrack, budgetMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.all([a, b]);
    expect(maxActive).toBe(2);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});

describe('resolveWithStatus schedules its own retry', () => {
  it('a retryable incomplete result carries retryAt, persisted in the cache, for every caller', async () => {
    mockFetch([
      ['api.deezer.com', () => { throw new Error('offline'); }],
      ['itunes.apple.com', () => json({ results: [] })],
      ['musicbrainz.org', () => json({ recordings: [] })],
    ]);
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved?.reason).toBe('providers-unavailable');
    expect(t.unresolved?.retryAt).toBeTypeOf('number');
    expect(getEntry(trackKeyOf('A', 'T'))?.retryAt).toBe(t.unresolved?.retryAt);
  });
  it('a permanent reason gets no retryAt', async () => {
    mockFetch([
      ['api.deezer.com', () => json({ data: [] })],
      ['itunes.apple.com', () => json({ results: [] })],
      ['musicbrainz.org', () => json({ recordings: [] })],
    ]);
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved?.reason).toBe('not-found');
    expect(t.unresolved?.retryAt).toBeUndefined();
  });
});
