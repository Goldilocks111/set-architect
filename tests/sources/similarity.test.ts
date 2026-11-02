// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastfmSimilar } from '@/lib/sources/lastfm';
import { listenbrainzSimilar } from '@/lib/sources/listenbrainz';
import { configureMusicBrainzLimiter, musicBrainzQueueDelayMs, MUSICBRAINZ_UA } from '@/lib/sources/musicbrainz';
import { configureLastfmPacing, resetLastfmTags } from '@/lib/sources/lastfmTags';
import { getSimilarTracks } from '@/lib/resolver';
import { cooldownUntil, resetBreakers, resetBudgets, takeBudget, APP_PER_MINUTE_BUDGET } from '@/lib/search/breaker';
import { getSimilarCached, putSimilar, SIMILAR_FALLBACK_TTL_MS, SIMILAR_TTL_MS } from '@/lib/similarCache';
import { trackKeyOf } from '@/types/track';
import { json, mockFetch } from './helpers';

beforeEach(() => {
  // the similar cache and the breaker persist under the data dir: never the owner's ~/.setarchitect
  vi.stubEnv('SETARCHITECT_DATA_DIR', fs.mkdtempSync(path.join(os.tmpdir(), 'similar-')));
  resetBreakers();
  resetBudgets();
  resetLastfmTags();
  configureLastfmPacing(0);
  configureMusicBrainzLimiter(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const lfm = () =>
  json({ similartracks: { track: [{ name: 'Around the World', match: '0.8', artist: { name: 'Daft Punk' } }] } });
const lb = [
  ['musicbrainz.org', () => json({ recordings: [{ id: 'mbid-1' }] })],
  [
    'labs.api.listenbrainz.org',
    () =>
      json([
        { recording_name: 'A', artist_credit_name: 'X', score: 200 },
        { recording_name: 'B', artist_credit_name: 'Y', score: 100 },
      ]),
  ],
] as Array<[string, () => Response]>;

describe('lastfm', () => {
  it('maps and coerces match to number', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['audioscrobbler', lfm]]);
    expect(await lastfmSimilar('Daft Punk', 'One More Time')).toEqual([
      { artist: 'Daft Punk', title: 'Around the World', match: 0.8 },
    ]);
  });
  it('error → throws', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['audioscrobbler', () => json({}, 403)]]);
    await expect(lastfmSimilar('a', 'b')).rejects.toThrow();
  });
  it('not-found body (error 6) is an empty answer', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['audioscrobbler', () => json({ error: 6, message: 'Track not found' })]]);
    expect(await lastfmSimilar('a', 'b')).toEqual([]);
  });
});

describe('listenbrainz', () => {
  it('resolves MBID then normalizes scores to 0..1', async () => {
    mockFetch(lb);
    expect(await listenbrainzSimilar('a', 'b')).toEqual([
      { artist: 'X', title: 'A', match: 1 },
      { artist: 'Y', title: 'B', match: 0.5 },
    ]);
  });
  it('unknown recording → []', async () => {
    mockFetch([['musicbrainz.org', () => json({ recordings: [] })]]);
    expect(await listenbrainzSimilar('a', 'b')).toEqual([]);
  });
  it('its MusicBrainz lookup goes through the shared 1 req/s limiter with the mandatory User-Agent', async () => {
    configureMusicBrainzLimiter(5000);
    const f = mockFetch(lb);
    await listenbrainzSimilar('a', 'b');
    expect(musicBrainzQueueDelayMs()).toBeGreaterThan(4000); // it took a slot in the shared queue
    const mbCall = f.mock.calls.find((c) => String(c[0]).includes('musicbrainz.org'))!;
    expect(new Headers(((mbCall as unknown[])[1] as RequestInit | undefined)?.headers).get('user-agent')).toBe(MUSICBRAINZ_UA);
  });
});

describe('getSimilarTracks', () => {
  it('uses Last.fm when keyed', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    const f = mockFetch([['audioscrobbler', lfm], ...lb]);
    const out = await getSimilarTracks('a', 'b');
    expect(out[0].title).toBe('Around the World');
    expect(f.mock.calls.some((c) => String(c[0]).includes('listenbrainz'))).toBe(false);
  });
  it('falls back to ListenBrainz when no key', async () => {
    vi.stubEnv('LASTFM_API_KEY', '');
    mockFetch(lb);
    expect((await getSimilarTracks('a', 'b'))[0].title).toBe('A');
  });
  it('falls back to ListenBrainz when Last.fm fails', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['audioscrobbler', () => json({}, 403)], ...lb]);
    expect((await getSimilarTracks('a', 'b'))[0].title).toBe('A');
  });
  it('returns [] when everything fails', async () => {
    vi.stubEnv('LASTFM_API_KEY', '');
    mockFetch([]);
    expect(await getSimilarTracks('a', 'b')).toEqual([]);
  });

  it('a ListenBrainz failure is cached for the fallback TTL (no Last.fm key)', async () => {
    vi.stubEnv('LASTFM_API_KEY', '');
    const f = mockFetch([['musicbrainz.org', () => json({}, 503)]]);
    expect(await getSimilarTracks('a', 'b')).toEqual([]);
    const calls = f.mock.calls.length;
    expect(await getSimilarTracks('a', 'b')).toEqual([]);
    expect(f).toHaveBeenCalledTimes(calls);
    const now = Date.now();
    expect(getSimilarCached(trackKeyOf('a', 'b'), now + SIMILAR_FALLBACK_TTL_MS - 1000)).toEqual([]);
    expect(getSimilarCached(trackKeyOf('a', 'b'), now + SIMILAR_FALLBACK_TTL_MS + 1000)).toBeUndefined();
  });
  it('empty Last.fm + ListenBrainz failure is cached for the fallback TTL: the next refresh asks nobody', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    const f = mockFetch([
      ['audioscrobbler', () => json({ similartracks: { track: [] } })],
      ['musicbrainz.org', () => json({}, 503)],
    ]);
    expect(await getSimilarTracks('a', 'b')).toEqual([]);
    const calls = f.mock.calls.length;
    expect(await getSimilarTracks('a', 'b')).toEqual([]);
    expect(f).toHaveBeenCalledTimes(calls);
    const now = Date.now();
    expect(getSimilarCached(trackKeyOf('a', 'b'), now + SIMILAR_FALLBACK_TTL_MS + 1000)).toBeUndefined();
  });
  it('skips the ListenBrainz fallback (no MusicBrainz slot taken, nothing cached) while the MusicBrainz queue is deep', async () => {
    vi.stubEnv('LASTFM_API_KEY', '');
    configureMusicBrainzLimiter(10_000);
    const f = mockFetch([['musicbrainz.org', () => json({ recordings: [] })]]);
    await listenbrainzSimilar('warm', 'up'); // takes a slot: the next one would wait ~10 s
    f.mockClear();
    expect(await getSimilarTracks('a', 'b')).toEqual([]);
    expect(f).not.toHaveBeenCalled();
    expect(getSimilarCached(trackKeyOf('a', 'b'))).toBeUndefined();
  });
  it('a cache hit makes no call', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    const f = mockFetch([['audioscrobbler', lfm], ...lb]);
    await getSimilarTracks('Daft Punk', 'One More Time');
    expect(f).toHaveBeenCalledTimes(1);
    // same trackKey, other spelling
    expect((await getSimilarTracks('daft punk', 'One More Time (Original Mix)'))[0].title).toBe('Around the World');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('empty answers are cached too', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    const f = mockFetch([
      ['audioscrobbler', () => json({ similartracks: { track: [] } })],
      ['musicbrainz.org', () => json({ recordings: [] })],
    ]);
    expect(await getSimilarTracks('a', 'b')).toEqual([]);
    const calls = f.mock.calls.length;
    expect(await getSimilarTracks('a', 'b')).toEqual([]);
    expect(f).toHaveBeenCalledTimes(calls);
    expect(getSimilarCached(trackKeyOf('a', 'b'))).toEqual([]);
  });
  it('while Last.fm cools down it is not called; ListenBrainz answers and is cached only briefly', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['audioscrobbler', () => json({ error: 29, message: 'Rate limit exceeded' })], ...lb]);
    await getSimilarTracks('x', 'y'); // code 29 opens the breaker
    expect(cooldownUntil('lastfm')).toBeGreaterThan(Date.now());
    const f = mockFetch([['audioscrobbler', lfm], ...lb]);
    expect((await getSimilarTracks('a', 'b'))[0].title).toBe('A');
    expect(f.mock.calls.some((c) => String(c[0]).includes('audioscrobbler'))).toBe(false);
    const now = Date.now();
    expect(getSimilarCached(trackKeyOf('a', 'b'), now + SIMILAR_FALLBACK_TTL_MS - 1000)).toBeDefined();
    expect(getSimilarCached(trackKeyOf('a', 'b'), now + SIMILAR_FALLBACK_TTL_MS + 1000)).toBeUndefined();
  });
  it('a code-29 body opens the lastfm breaker', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['audioscrobbler', () => json({ error: 29, message: 'Rate limit exceeded' })], ...lb]);
    expect(cooldownUntil('lastfm')).toBe(0);
    expect((await getSimilarTracks('a', 'b'))[0].title).toBe('A');
    expect(cooldownUntil('lastfm')).toBeGreaterThan(Date.now());
  });
  it('a spent lastfm app budget skips Last.fm without opening the breaker', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    for (let i = 0; i < APP_PER_MINUTE_BUDGET.lastfm!; i++) takeBudget('lastfm', { app: true });
    const f = mockFetch([['audioscrobbler', lfm], ...lb]);
    expect((await getSimilarTracks('a', 'b'))[0].title).toBe('A');
    expect(f.mock.calls.some((c) => String(c[0]).includes('audioscrobbler'))).toBe(false);
    expect(cooldownUntil('lastfm')).toBe(0);
  });
  it('each Last.fm call spends one app budget unit', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['audioscrobbler', lfm], ...lb]);
    await getSimilarTracks('a', 'b');
    let left = 0;
    while (takeBudget('lastfm', { app: true })) left++;
    expect(left).toBe(APP_PER_MINUTE_BUDGET.lastfm! - 1);
  });
  it('3 parallel seed lookups share the process-wide Last.fm pacing', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    configureLastfmPacing(250);
    vi.useFakeTimers();
    const at: number[] = [];
    mockFetch([['audioscrobbler', () => (at.push(Date.now()), lfm())]]);
    const all = Promise.all([getSimilarTracks('a', '1'), getSimilarTracks('a', '2'), getSimilarTracks('a', '3')]);
    await vi.advanceTimersByTimeAsync(1000);
    await all;
    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(250);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(250);
  });
});

describe('similarCache', () => {
  it('expires after 24 h and drops expired entries on write', () => {
    putSimilar('k|1', [{ artist: 'A', title: 'B', match: 1 }], { now: 1000 });
    expect(getSimilarCached('k|1', 1000 + SIMILAR_TTL_MS - 1)).toHaveLength(1);
    expect(getSimilarCached('k|1', 1000 + SIMILAR_TTL_MS)).toBeUndefined();
    putSimilar('k|2', [], { now: 1000 + SIMILAR_TTL_MS });
    const raw = JSON.parse(fs.readFileSync(path.join(process.env.SETARCHITECT_DATA_DIR!, 'index', 'similar.json'), 'utf8'));
    expect(Object.keys(raw)).toEqual(['k|2']);
  });
});
