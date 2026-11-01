import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, mockFetch } from './helpers';

const analysePreview = vi.fn();
vi.mock('@/lib/analysis/previewAnalysis', () => ({ analysePreview: (...a: unknown[]) => analysePreview(...a), ANALYSIS_TIMEOUT_MS: 5000 }));

import { resolveWithStatus } from '@/lib/resolver';
import { getEntry, putManual, putResolved } from '@/lib/metadataCache';
import { dataDir } from '@/lib/dataDir';
import { HttpError } from '@/lib/http';
import { resetBreakers, recordFailure } from '@/lib/search/breaker';
import { clearSearchCache } from '@/lib/search/cache';
import { resetProviderBudgets } from '@/lib/search/merge';
import { configureMusicBrainzLimiter } from '@/lib/sources/musicbrainz';
import { trackKeyOf } from '@/types/track';

const KEY = trackKeyOf('A', 'T');
const deezerHit = (over = {}) => ({ id: 1, title: 'T', rank: 5, artist: { name: 'A' }, ...over });
const routes = (deezer: unknown[]): Array<[string, () => Response]> => [
  ['api.deezer.com', () => json({ data: deezer })],
  ['itunes.apple.com', () => json({ results: [] })],
  ['musicbrainz.org', () => json({ recordings: [] })],
];

beforeEach(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-status-'));
  clearSearchCache();
  resetProviderBudgets();
  resetBreakers();
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

describe('resolveWithStatus', () => {
  it('a complete cache entry makes zero essentials-adapter calls (only the preview adapters may run)', async () => {
    putResolved(KEY, { id: KEY, artist: 'A', title: 'T', bpm: 124, camelot: '8A', energy: 7, danceability: 0, sources: { bpm: 'x' } });
    const fetchFn = mockFetch([
      ['api.deezer.com', () => json({ data: [] })],
      ['itunes.apple.com', () => json({ results: [] })],
    ]);
    const t = await resolveWithStatus('A', 'T');
    const hosts = new Set(fetchFn.mock.calls.map((c) => new URL(String(c[0])).hostname));
    expect([...hosts].every((h) => h === 'api.deezer.com' || h === 'itunes.apple.com')).toBe(true);
    expect(t.bpm).toBe(124);
    expect(t.unresolved).toBeUndefined();
  });

  it('complete result is cached and unresolved is absent', async () => {
    mockFetch(routes([deezerHit({ preview: 'dz', bpm: 128 })]));
    analysePreview.mockResolvedValue({ bpm: 128, camelot: '8A', energy: 7, danceability: 0.7 });
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved).toBeUndefined();
    expect(getEntry(KEY)?.fields.camelot).toBe('8A');
  });

  it('no provider match -> not-found', async () => {
    mockFetch(routes([]));
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved?.reason).toBe('not-found');
    expect(t.unresolved?.missing).toEqual(['bpm', 'camelot', 'energy', 'danceability']);
  });

  it('matched but no Deezer preview and fields missing -> no-preview', async () => {
    mockFetch(routes([deezerHit()]));
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved?.reason).toBe('no-preview');
    expect(analysePreview).not.toHaveBeenCalled();
  });

  it('preview present but analysis yields nothing -> analysis-failed', async () => {
    mockFetch(routes([deezerHit({ preview: 'dz' })]));
    analysePreview.mockResolvedValue({});
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved?.reason).toBe('analysis-failed');
  });

  it('a breaker cooldown that skipped a guarded adapter -> providers-unavailable', async () => {
    recordFailure('deezer', new HttpError(429, 'https://api.deezer.com', 60_000));
    mockFetch(routes([]));
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved?.reason).toBe('providers-unavailable');
  });

  it('manual fields beat a later resolve', async () => {
    putManual(KEY, { bpm: 99 });
    mockFetch(routes([deezerHit({ preview: 'dz', bpm: 128 })]));
    analysePreview.mockResolvedValue({ bpm: 128, camelot: '8A', energy: 7, danceability: 0.7 });
    const t = await resolveWithStatus('A', 'T');
    expect(t.bpm).toBe(99);
    expect(t.sources.bpm).toBe('manual');
  });

  it('exceeding the overall budget returns what is resolved with reason timeout', async () => {
    vi.useFakeTimers();
    mockFetch([
      ['api.deezer.com', () => json({ data: [deezerHit({ preview: 'dz' })] })],
      ['itunes.apple.com', () => new Promise<Response>(() => {})], // never settles
      ['musicbrainz.org', () => new Promise<Response>(() => {})],
    ]);
    const p = resolveWithStatus('A', 'T', { budgetMs: 1000 });
    await vi.advanceTimersByTimeAsync(1500);
    const t = await p;
    expect(t.unresolved?.reason).toBe('timeout');
    expect(t.popularity).toBeDefined();
  });
});

describe('provider errors are retryable, not permanent', () => {
  it('Deezer throwing (offline) -> providers-unavailable', async () => {
    mockFetch([
      ['api.deezer.com', () => { throw new Error('offline'); }],
      ['itunes.apple.com', () => json({ results: [] })],
      ['musicbrainz.org', () => json({ recordings: [] })],
    ]);
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved?.reason).toBe('providers-unavailable');
  });
  it('Deezer 429 -> providers-unavailable', async () => {
    mockFetch([
      ['api.deezer.com', () => json({}, 429)],
      ['itunes.apple.com', () => json({ results: [] })],
      ['musicbrainz.org', () => json({ recordings: [] })],
    ]);
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved?.reason).toBe('providers-unavailable');
  });
  it('Deezer 500 with a match elsewhere but no preview -> providers-unavailable, not no-preview', async () => {
    mockFetch([
      ['api.deezer.com', () => json({}, 500)],
      ['itunes.apple.com', () => json({ results: [{ trackId: 2, trackName: 'T', artistName: 'A', trackViewUrl: 'u' }] })],
      ['musicbrainz.org', () => json({ recordings: [] })],
    ]);
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved?.reason).toBe('providers-unavailable');
  });
});

describe('complete cache hit still attaches a fresh preview', () => {
  it('runs only deezer/itunes, prefers iTunes previewUrl, never persists it', async () => {
    putResolved(KEY, { id: KEY, artist: 'A', title: 'T', bpm: 124, camelot: '8A', energy: 7, danceability: 0.5, sources: {} });
    const fetchFn = mockFetch([
      ['api.deezer.com', () => json({ data: [deezerHit({ preview: 'dz-prev' })] })],
      ['itunes.apple.com', () => json({ results: [{ trackId: 2, trackName: 'T', artistName: 'A', previewUrl: 'it-prev', trackViewUrl: 'u' }] })],
    ]);
    const t = await resolveWithStatus('A', 'T');
    expect(t.previewUrl).toBe('it-prev');
    expect(t.bpm).toBe(124);
    const hosts = fetchFn.mock.calls.map((c) => new URL(String(c[0])).hostname);
    expect(new Set(hosts)).toEqual(new Set(['api.deezer.com', 'itunes.apple.com']));
    expect(fs.readFileSync(dataDir('index', 'metadata.json'), 'utf8')).not.toContain('prev');
  });
  it('falls back to Deezer preview when iTunes has none; adapter failures are swallowed', async () => {
    putResolved(KEY, { id: KEY, artist: 'A', title: 'T', bpm: 124, camelot: '8A', energy: 7, danceability: 0.5, sources: {} });
    mockFetch([
      ['api.deezer.com', () => json({ data: [deezerHit({ preview: 'dz-prev' })] })],
      ['itunes.apple.com', () => { throw new Error('x'); }],
    ]);
    expect((await resolveWithStatus('A', 'T')).previewUrl).toBe('dz-prev');
  });
});

describe('negative cache', () => {
  const H = 24 * 60 * 60_000;
  const incomplete = (reason: 'not-found' | 'timeout') =>
    ({ id: KEY, artist: 'A', title: 'T', sources: {}, unresolved: { reason, missing: ['bpm', 'camelot', 'energy', 'danceability'] } }) as never;

  it('a permanent reason is served from cache within 24h with zero adapter calls', async () => {
    putResolved(KEY, incomplete('not-found'), Date.now() - 1000);
    const fetchFn = mockFetch([]);
    const t = await resolveWithStatus('A', 'T');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(t.unresolved?.reason).toBe('not-found');
  });
  it('is re-resolved after 24h', async () => {
    putResolved(KEY, incomplete('not-found'), Date.now() - H - 1000);
    const fetchFn = mockFetch(routes([]));
    await resolveWithStatus('A', 'T');
    expect(fetchFn).toHaveBeenCalled();
  });
  it('exhausted retries (no retryAt) are still served from cache', async () => {
    putResolved(KEY, incomplete('timeout'), Date.now() - 1000);
    const fetchFn = mockFetch([]);
    const t = await resolveWithStatus('A', 'T');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(t.unresolved?.reason).toBe('timeout');
  });
  it('a retryable entry past its retryAt is re-resolved; force bypasses the cache', async () => {
    putResolved(KEY, incomplete('timeout'), Date.now() - 1000);
    const { setRetry } = await import('@/lib/metadataCache');
    setRetry(KEY, Date.now() - 1);
    const fetchFn = mockFetch(routes([]));
    await resolveWithStatus('A', 'T');
    expect(fetchFn).toHaveBeenCalled();
    fetchFn.mockClear();
    putResolved(KEY, incomplete('not-found'), Date.now());
    await resolveWithStatus('A', 'T', { force: true });
    expect(fetchFn).toHaveBeenCalled();
  });
});
