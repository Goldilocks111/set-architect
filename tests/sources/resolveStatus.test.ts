import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, mockFetch } from './helpers';

const analysePreview = vi.fn();
vi.mock('@/lib/analysis/previewAnalysis', () => ({ analysePreview: (...a: unknown[]) => analysePreview(...a), ANALYSIS_TIMEOUT_MS: 5000 }));

import { queueStyles, resolveWithStatus, settleStyles, stylesFillOpen, STYLES_FILL_MAX_QUEUE, STYLES_QUEUE_CAP } from '@/lib/resolver';
import { configureLastfmPacing, resetLastfmTags } from '@/lib/sources/lastfmTags';
import { getEntry, putManual, putResolved } from '@/lib/metadataCache';
import { dataDir } from '@/lib/dataDir';
import { HttpError } from '@/lib/http';
import { resetBreakers, recordFailure, cooldownUntil, resetBudgets, takeBudget } from '@/lib/search/breaker';
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
  resetBudgets();
  resetLastfmTags();
  configureLastfmPacing(0);
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
    expect(t.unresolved?.reason).toBe('exhausted'); // retryable reason, no retries left
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

describe('styles (Last.fm tags → lanes)', () => {
  const complete = () =>
    putResolved(KEY, { id: KEY, artist: 'A', title: 'T', bpm: 124, camelot: '8A', energy: 7, danceability: 0, sources: { bpm: 'x' } });
  const lfmTags = (n: string) => json({ toptags: { tag: [{ name: n, count: 100 }, { name: 'deep house', count: 40 }] } });
  const base = (): Array<[string, () => Response]> => [
    ['api.deezer.com', () => json({ data: [] })],
    ['itunes.apple.com', () => json({ results: [] })],
  ];
  const lfmRoutes = (calls: { n: number }): Array<[string, () => Response]> => [
    ...base(),
    ['audioscrobbler', () => { calls.n++; return lfmTags('melodic techno'); }],
  ];

  it('the response does not wait for the lookup; the cache gets styles afterwards; the next call makes no Last.fm call', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    complete();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    mockFetch([...base(), ['audioscrobbler', async () => { n++; await gate; return lfmTags('melodic techno'); }]]);
    const t = await resolveWithStatus('A', 'T'); // resolves although the lookup is still pending
    expect(t.styles).toBeUndefined();
    expect(getEntry(KEY)?.fields.styles).toBeUndefined();
    release();
    await settleStyles();
    expect(getEntry(KEY)?.fields.styles).toEqual(['melodic-techno', 'deep-house']);
    expect(getEntry(KEY)?.sources.styles).toBe('lastfm-tags');
    const t2 = await resolveWithStatus('A', 'T');
    await settleStyles();
    expect(t2.styles).toEqual(['melodic-techno', 'deep-house']);
    expect(t2.sources.styles).toBe('lastfm-tags');
    expect(n).toBe(1);
  });
  it('at most one in-flight lookup per track', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    complete();
    const calls = { n: 0 };
    mockFetch(lfmRoutes(calls));
    await Promise.all([resolveWithStatus('A', 'T'), resolveWithStatus('A', 'T'), resolveWithStatus('A', 'T')]);
    await settleStyles();
    expect(calls.n).toBe(1);
  });
  it('a track with no genre tags is marked and not re-queried for 7 days', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    complete();
    let n = 0;
    mockFetch([...base(), ['audioscrobbler', () => { n++; return json({ toptags: { tag: [] } }); }]]);
    await resolveWithStatus('A', 'T');
    await settleStyles();
    expect(n).toBe(2); // track + artist lookup
    await resolveWithStatus('A', 'T');
    await settleStyles();
    expect(n).toBe(2);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * 24 * 3600_000);
    await resolveWithStatus('A', 'T');
    await settleStyles();
    expect(n).toBe(4);
  });
  it('unknown artist and track (error 6 twice) writes the marker: no repeat calls', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    complete();
    let n = 0;
    mockFetch([...base(), ['audioscrobbler', () => { n++; return json({ error: 6, message: 'not found' }); }]]);
    await resolveWithStatus('A', 'T');
    await settleStyles();
    expect(getEntry(KEY)?.stylesCheckedAt).toBeDefined();
    const before = n;
    await resolveWithStatus('A', 'T');
    await settleStyles();
    expect(n).toBe(before);
  });
  it('Last.fm failure never blocks completeness', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    complete();
    mockFetch([...base(), ['audioscrobbler', () => json({ error: 8, message: 'Operation failed' })]]);
    const t = await resolveWithStatus('A', 'T');
    await settleStyles();
    expect(t.unresolved).toBeUndefined();
    expect(t.bpm).toBe(124);
    expect(t.styles).toBeUndefined();
  });
  it('budget refusal skips the step silently', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    complete();
    const calls = { n: 0 };
    mockFetch(lfmRoutes(calls));
    for (let i = 0; i < 120; i++) takeBudget('lastfm', { app: true });
    const t = await resolveWithStatus('A', 'T');
    await settleStyles();
    expect(calls.n).toBe(0);
    expect(t.unresolved).toBeUndefined();
    expect(getEntry(KEY)?.stylesCheckedAt).toBeUndefined();
  });
  it('HTTP 429 opens the lastfm breaker', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    complete();
    let n = 0;
    mockFetch([...base(), ['audioscrobbler', () => { n++; return json({}, 429); }]]);
    await resolveWithStatus('A', 'T');
    await settleStyles();
    await resolveWithStatus('A', 'T');
    await settleStyles();
    expect(n).toBe(1);
  });
  it('a rate-limit body (code 29 on HTTP 200) opens the breaker: the next resolve makes no Last.fm call', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    complete();
    let n = 0;
    mockFetch([...base(), ['audioscrobbler', () => { n++; return json({ error: 29, message: 'Rate limit exceeded' }); }]]);
    await resolveWithStatus('A', 'T');
    await settleStyles();
    await resolveWithStatus('A', 'T');
    await settleStyles();
    expect(n).toBe(1);
  });
  it('is not an essential: an incomplete track stays unresolved and no lookup is made', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    const calls = { n: 0 };
    mockFetch(lfmRoutes(calls).concat([['musicbrainz.org', () => json({ recordings: [] })]]));
    const t = await resolveWithStatus('A', 'T');
    await settleStyles();
    expect(t.unresolved).toBeDefined();
    expect(calls.n).toBe(0);
  });
});

describe('styles queue', () => {
  const seed = (i: number) => {
    const k = trackKeyOf(`Art${i}`, `Trk${i}`);
    putResolved(k, { id: k, artist: `Art${i}`, title: `Trk${i}`, bpm: 124, camelot: '8A', energy: 7, danceability: 0, sources: { bpm: 'x' } });
    return { id: k, artist: `Art${i}`, title: `Trk${i}`, sources: {} };
  };
  const two = () => json({ toptags: { tag: [{ name: 'techno', count: 9 }, { name: 'house', count: 8 }] } });

  it('50 lookups queued at once: no timeouts, no breaker failure, <= 2 concurrent, paced', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    configureLastfmPacing(90); // 50 x 90 ms > the 4 s per-call timeout: queue wait must not count against it
    let inflight = 0;
    let maxInflight = 0;
    const at: number[] = [];
    mockFetch([['audioscrobbler', async () => {
      at.push(Date.now());
      resetBudgets(); // the 120/min budget and its 50% styles floor are not under test here
      maxInflight = Math.max(maxInflight, ++inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return two();
    }]]);
    const tracks = Array.from({ length: 50 }, (_, i) => seed(i));
    for (const t of tracks) queueStyles(t);
    await settleStyles();
    expect(at.length).toBe(50);
    expect(maxInflight).toBeLessThanOrEqual(2);
    expect(at[49] - at[0]).toBeGreaterThanOrEqual(49 * 85); // <= ~11 req/s here; 4/s at the default 250 ms
    expect(cooldownUntil('lastfm')).toBe(0);
    for (let i = 0; i < 50; i++) expect(getEntry(trackKeyOf(`Art${i}`, `Trk${i}`))?.fields.styles).toEqual(['techno', 'house']);
  }, 20_000);

  it('queue is capped at 200 waiting: the oldest are dropped, no marker written', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    mockFetch([['audioscrobbler', async () => { n++; resetBudgets(); await gate; return two(); }]]); // the 120/min budget is not under test here
    const tracks = Array.from({ length: 210 }, (_, i) => seed(i));
    for (const t of tracks) queueStyles(t);
    release();
    await settleStyles();
    expect(n).toBe(2 + STYLES_QUEUE_CAP);
    expect(getEntry(trackKeyOf('Art2', 'Trk2'))?.stylesCheckedAt).toBeUndefined();
    expect(getEntry(trackKeyOf('Art2', 'Trk2'))?.fields.styles).toBeUndefined();
    expect(getEntry(trackKeyOf('Art209', 'Trk209'))?.fields.styles).toEqual(['techno', 'house']);
  }, 20_000);

  it('a styles job spends nothing once Last.fm headroom is under 50% (70/120 used); a similarity lookup still can', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    const f = mockFetch([['audioscrobbler', () => two()]]);
    for (let i = 0; i < 70; i++) expect(takeBudget('lastfm', { app: true })).toBe(true);
    const t = seed(900);
    expect(stylesFillOpen()).toBe(false);
    queueStyles(t);
    await settleStyles();
    expect(f).not.toHaveBeenCalled();
    expect(getEntry(trackKeyOf(t.artist, t.title))?.stylesCheckedAt).toBeUndefined(); // skipped, not marked: its next resolve re-queues it
    expect(getEntry(trackKeyOf(t.artist, t.title))?.fields.styles).toBeUndefined();
    expect(cooldownUntil('lastfm')).toBe(0);
    expect(takeBudget('lastfm', { app: true })).toBe(true); // similarity is not starved
  });

  it('stylesFillOpen: queue under its fill limit AND Last.fm headroom >= 50%', async () => {
    expect(stylesFillOpen()).toBe(true);
    for (let i = 0; i < 61; i++) takeBudget('lastfm', { app: true });
    expect(stylesFillOpen()).toBe(false);
    resetBudgets();
    vi.stubEnv('LASTFM_API_KEY', 'k');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockFetch([['audioscrobbler', async () => { await gate; return two(); }]]);
    for (let i = 0; i < 2 + STYLES_FILL_MAX_QUEUE; i++) queueStyles(seed(1000 + i));
    expect(stylesFillOpen()).toBe(false);
    release();
    await settleStyles();
  });

  it('queueStyles failures never fail resolveWithStatus', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    putResolved(KEY, { id: KEY, artist: 'A', title: 'T', bpm: 124, camelot: '8A', energy: 7, danceability: 0, sources: { bpm: 'x' } });
    mockFetch([['api.deezer.com', () => json({ data: [] })], ['itunes.apple.com', () => json({ results: [] })], ['audioscrobbler', () => json({}, 500)]]);
    await expect(resolveWithStatus('A', 'T')).resolves.toMatchObject({ bpm: 124 });
    await settleStyles();
  });
});
