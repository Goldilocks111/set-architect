import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastfmSimilar } from '@/lib/sources/lastfm';
import { listenbrainzSimilar } from '@/lib/sources/listenbrainz';
import { getSimilarTracks } from '@/lib/resolver';
import { json, mockFetch } from './helpers';

afterEach(() => {
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
});
