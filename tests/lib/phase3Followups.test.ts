// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, mockFetch } from '../sources/helpers';

const analysePreview = vi.fn();
vi.mock('@/lib/analysis/previewAnalysis', () => ({ analysePreview: (...a: unknown[]) => analysePreview(...a), ANALYSIS_TIMEOUT_MS: 5000 }));

import { assembleSuggestions, loadSuggestDeps, MAX_CANDIDATE_RESOLVES, resetCandidateLimiter } from '@/app/api/suggest/assemble';
import { resolveWithStatus } from '@/lib/resolver';
import { getEntry, putResolved } from '@/lib/metadataCache';
import { RETRY_BACKOFF_MS, resetReresolve, scheduleRetry, setReresolveDeps } from '@/lib/reresolve';
import { budgetHeadroom, resetBreakers, resetBudgets, takeBudget } from '@/lib/search/breaker';
import { clearSearchCache } from '@/lib/search/cache';
import { resetProviderBudgets } from '@/lib/search/merge';
import { configureMusicBrainzLimiter } from '@/lib/sources/musicbrainz';
import { demoTracks } from '@/lib/demo';
import { trackKeyOf, type Track } from '@/types/track';

const last = demoTracks()[0];
const input = { playlist: [last], template: '60min' as const, plannedLength: 15 };
const hosts = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls.map((c) => new URL(String(c[0])).hostname);
const routes = (): Parameters<typeof mockFetch>[0] => [
  ['api.deezer.com', () => json({ data: [{ id: 1, title: 'T', rank: 5, preview: 'dz', artist: { name: 'A' } }] })],
  ['itunes.apple.com', () => json({ results: [] })],
  ['musicbrainz.org', () => json({ recordings: [] })],
];

beforeEach(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'p3t3-'));
  clearSearchCache();
  resetProviderBudgets();
  resetBreakers();
  resetBudgets();
  resetCandidateLimiter();
  resetReresolve();
  configureMusicBrainzLimiter(0);
  analysePreview.mockReset();
  analysePreview.mockResolvedValue({});
  for (const k of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'GETSONGBPM_API_KEY', 'SOUNDSTAT_API_KEY', 'YOUTUBE_API_KEY', 'LASTFM_API_KEY'])
    vi.stubEnv(k, '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('not-due starvation', () => {
  it('skips candidates whose cache entry is incomplete and not yet due BEFORE the per-refresh slice', async () => {
    const similar = Array.from({ length: 8 }, (_, i) => ({ artist: `Art${i}`, title: `T${i}`, match: 1 - i / 100 }));
    const deadKeys = new Set(similar.slice(0, 4).map((s) => trackKeyOf(s.artist, s.title)));
    const getCachedEntry = (k: string) =>
      deadKeys.has(k) ? { fields: {}, reason: 'timeout', retryAt: Date.now() + 60_000, resolvedAt: Date.now() } : undefined;
    const resolveTrack = vi.fn(async (artist: string, title: string) => ({ id: title, artist, title, sources: {} }) as Track);
    await assembleSuggestions(input, { getSimilarTracks: async () => similar, getCachedEntry, resolveTrack });
    expect(resolveTrack.mock.calls.map((c) => c[1])).toEqual(['T4', 'T5', 'T6', 'T7'].slice(0, MAX_CANDIDATE_RESOLVES));
  });
  it('a due (past retryAt) or expired negative entry is still resolved', async () => {
    const similar = [{ artist: 'Due', title: 'Now', match: 1 }, { artist: 'Neg', title: 'Old', match: 0.9 }];
    const getCachedEntry = (k: string) =>
      k === trackKeyOf('Due', 'Now')
        ? { fields: {}, reason: 'timeout', retryAt: Date.now() - 1, resolvedAt: 1 }
        : { fields: {}, reason: 'not-found', resolvedAt: Date.now() - 25 * 3600_000 };
    const resolveTrack = vi.fn(async (artist: string, title: string) => ({ id: title, artist, title, sources: {} }) as Track);
    await assembleSuggestions(input, { getSimilarTracks: async () => similar, getCachedEntry, resolveTrack });
    expect(resolveTrack).toHaveBeenCalledTimes(2);
  });
});

describe('budgetHeadroom', () => {
  it('is the unspent fraction of the tightest limit, 0 on cooldown, 1 when unlimited', () => {
    const now = 1_000_000;
    expect(budgetHeadroom('itunes', {}, now)).toBe(1);
    for (let i = 0; i < 15; i++) takeBudget('itunes', {}, now);
    expect(budgetHeadroom('itunes', {}, now)).toBeCloseTo(0.25);
    for (let i = 0; i < 6; i++) takeBudget('spotify', { app: true }, now);
    expect(budgetHeadroom('spotify', { app: true }, now)).toBeCloseTo(0.8);
    expect(budgetHeadroom('spotify', {}, now)).toBe(1); // app budget only counts when asked for
    expect(budgetHeadroom('deezer', { app: true }, now)).toBe(1);
    expect(budgetHeadroom('itunes', {}, now + 61_000)).toBe(1); // rolling minute
  });
});

describe('self-starvation: candidate resolves leave half the budget to the user', () => {
  it('with 15/20 iTunes used a candidate refresh makes no iTunes call; a user resolve still does', async () => {
    const fetchFn = mockFetch(routes());
    for (let i = 0; i < 15; i++) takeBudget('itunes');
    const deps = { ...(await loadSuggestDeps()), loadAdjacency: undefined, getSimilarTracks: async () => [{ artist: 'Out', title: 'Side', match: 0.9 }] };
    await assembleSuggestions(input, deps);
    expect(hosts(fetchFn)).toContain('api.deezer.com');
    expect(hosts(fetchFn)).not.toContain('itunes.apple.com');
    fetchFn.mockClear();
    await resolveWithStatus('User', 'Track');
    expect(hosts(fetchFn)).toContain('itunes.apple.com');
  });
  it('with plenty of headroom candidates may use iTunes', async () => {
    const fetchFn = mockFetch(routes());
    for (let i = 0; i < 5; i++) takeBudget('itunes');
    const deps = { ...(await loadSuggestDeps()), loadAdjacency: undefined, getSimilarTracks: async () => [{ artist: 'Out', title: 'Side', match: 0.9 }] };
    await assembleSuggestions(input, deps);
    expect(hosts(fetchFn)).toContain('itunes.apple.com');
  });
  it('the background crate fill needs >= 50% Spotify headroom', async () => {
    const mocked = vi.fn(async () => ({}));
    vi.resetModules();
    vi.doMock('@/lib/resolver', async (orig) => ({ ...(await orig<typeof import('@/lib/resolver')>()), resolveWithStatus: mocked }));
    try {
      const { loadSuggestDeps: load } = await import('@/app/api/suggest/assemble');
      const breaker = await import('@/lib/search/breaker');
      breaker.resetBudgets();
      const deps = await load();
      for (let i = 0; i < 16; i++) breaker.takeBudget('spotify', { app: true }); // 16/30 used: 47% left
      await deps.backgroundResolve!('A', 'B');
      expect(mocked).not.toHaveBeenCalled();
      breaker.resetBudgets();
      for (let i = 0; i < 15; i++) breaker.takeBudget('spotify', { app: true }); // exactly 50% left
      await deps.backgroundResolve!('A', 'B');
      expect(mocked).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('@/lib/resolver');
      vi.resetModules();
    }
  });
});

describe('iTunes leaks in the background fill', () => {
  const complete = { id: 'x', artist: 'A', title: 'T', bpm: 124, camelot: '8A', energy: 6, danceability: 0.7, sources: {} } as Track;
  it('a cache-hit preview refresh honours `without`', async () => {
    putResolved(trackKeyOf('A', 'T'), complete);
    const fetchFn = mockFetch(routes());
    await resolveWithStatus('A', 'T', { without: ['itunes'] });
    expect(hosts(fetchFn)).toContain('api.deezer.com');
    expect(hosts(fetchFn)).not.toContain('itunes.apple.com');
    fetchFn.mockClear();
    await resolveWithStatus('A', 'T');
    expect(hosts(fetchFn)).toContain('itunes.apple.com');
  });
  it('a retry scheduled by a `without` resolve carries it to the queued re-resolve', async () => {
    const timers: Array<() => void> = [];
    const resolve = vi.fn(async (artist: string, title: string, _opts?: { without?: string[] }) => ({ id: 'a', artist, title, sources: {} }) as Track);
    setReresolveDeps({ setTimer: (fn) => void timers.push(fn), resolve });
    putResolved('a|b', { id: 'a|b', artist: 'a', title: 'b', sources: {}, unresolved: { reason: 'timeout', missing: ['bpm'] } });
    scheduleRetry('a', 'b', 'timeout', ['itunes']);
    timers.forEach((f) => f());
    await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(resolve.mock.calls[0]).toEqual(['a', 'b', { without: ['itunes'] }]);
  });
  it('resolveWithStatus passes its `without` into the retry', async () => {
    const timers: Array<() => void> = [];
    const resolve = vi.fn(async (artist: string, title: string, _opts?: { without?: string[] }) => ({ id: 'a', artist, title, sources: {} }) as Track);
    setReresolveDeps({ setTimer: (fn) => void timers.push(fn), resolve });
    mockFetch([
      ['api.deezer.com', () => { throw new Error('offline'); }],
      ['musicbrainz.org', () => json({ recordings: [] })],
    ]);
    const t = await resolveWithStatus('Q', 'R', { without: ['itunes'] });
    expect(t.unresolved?.retryAt).toBeTypeOf('number');
    timers.forEach((f) => f());
    await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(resolve.mock.calls[0][2]).toEqual({ without: ['itunes'] });
  });
});

describe('exhausted retries', () => {
  it('a retryable verdict with no retries left comes back as reason exhausted (fresh and cached)', async () => {
    const key = trackKeyOf('E', 'X');
    const stub: Track = { id: key, artist: 'E', title: 'X', sources: {} };
    for (let i = 0; i < RETRY_BACKOFF_MS.length; i++) putResolved(key, stub);
    mockFetch([
      ['api.deezer.com', () => { throw new Error('offline'); }],
      ['musicbrainz.org', () => json({ recordings: [] })],
    ]);
    const fresh = await resolveWithStatus('E', 'X', { force: true });
    expect(fresh.unresolved?.reason).toBe('exhausted');
    expect(fresh.unresolved?.retryAt).toBeUndefined();
    const cached = await resolveWithStatus('E', 'X');
    expect(cached.unresolved?.reason).toBe('exhausted');
    expect(getEntry(key)?.retryAt).toBeUndefined();
  });
});
