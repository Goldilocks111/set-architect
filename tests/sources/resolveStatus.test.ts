import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, mockFetch } from './helpers';

const analysePreview = vi.fn();
vi.mock('@/lib/analysis/previewAnalysis', () => ({ analysePreview: (...a: unknown[]) => analysePreview(...a), ANALYSIS_TIMEOUT_MS: 5000 }));

import { resolveWithStatus } from '@/lib/resolver';
import { getEntry, putManual, putResolved } from '@/lib/metadataCache';
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
  it('a complete cache entry makes zero adapter calls', async () => {
    putResolved(KEY, { id: KEY, artist: 'A', title: 'T', bpm: 124, camelot: '8A', energy: 7, danceability: 0, sources: { bpm: 'x' } });
    const fetchFn = mockFetch([]);
    const t = await resolveWithStatus('A', 'T');
    expect(fetchFn).not.toHaveBeenCalled();
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
