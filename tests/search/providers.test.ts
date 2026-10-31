import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/search/version', () => ({
  parseVersion: (title: string) => ({ baseTitle: title, kind: 'original', featuring: [] }),
}));

import {
  searchProviders,
  spotifySearchProvider,
  deezerSearchProvider,
  itunesSearchProvider,
} from '@/lib/search/providers';
import { resetSpotifyTokenCache } from '@/lib/sources/spotify';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('SPOTIFY_CLIENT_ID', 'id');
  vi.stubEnv('SPOTIFY_CLIENT_SECRET', 'secret');
  resetSpotifyTokenCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('registry', () => {
  it('lists spotify, deezer, itunes in order', () => {
    expect(searchProviders.map((p) => p.name)).toEqual(['spotify', 'deezer', 'itunes']);
  });
});

describe('spotify', () => {
  const item = {
    id: 'abc',
    name: 'Latch',
    duration_ms: 255631,
    explicit: false,
    popularity: 80,
    external_urls: { spotify: 'https://open.spotify.com/track/abc' },
    external_ids: { isrc: 'GBUM71302810' },
    artists: [{ name: 'Disclosure' }, { name: 'Sam Smith' }],
    album: {
      release_date: '2013-06-03',
      images: [
        { url: 'big', width: 1200 },
        { url: 'a640', width: 640 },
        { url: 'a300', width: 300 },
      ],
    },
  };

  it('maps a happy-path result and caps limit at 10', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 't', expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(json({ tracks: { items: [item] } }));
    const [r] = await spotifySearchProvider.search('disclosure latch', { limit: 50 });
    expect(r).toMatchObject({
      provider: 'spotify',
      providerId: 'abc',
      artist: 'Disclosure, Sam Smith',
      artists: ['Disclosure', 'Sam Smith'],
      title: 'Latch',
      isrc: 'GBUM71302810',
      durationMs: 255631,
      releaseDate: '2013-06-03',
      popularity: 80,
      artworkUrl: 'a640',
      spotifyId: 'abc',
      spotifyUrl: 'https://open.spotify.com/track/abc',
      explicit: false,
    });
    expect(r.version.kind).toBe('original');
    const url = fetchMock.mock.calls[1][0] as string;
    expect(url).toContain('type=track');
    expect(url).toContain('limit=10');
    expect(url).toContain('q=disclosure%20latch');
  });

  it('returns [] when there are no results', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 't', expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(json({ tracks: { items: [] } }));
    expect(await spotifySearchProvider.search('zzz')).toEqual([]);
  });

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 't', expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(json({}, 403));
    await expect(spotifySearchProvider.search('x')).rejects.toThrow(/403/);
  });

  it('configured() follows the env credentials', () => {
    expect(spotifySearchProvider.configured()).toBe(true);
    vi.stubEnv('SPOTIFY_CLIENT_SECRET', '');
    expect(spotifySearchProvider.configured()).toBe(false);
  });
});

describe('deezer', () => {
  const item = {
    id: 75526535,
    title: 'Latch',
    title_version: '',
    isrc: 'GBUM71302810',
    duration: 257,
    rank: 811242,
    explicit_lyrics: false,
    preview: 'https://p/x.mp3',
    artist: { name: 'Disclosure' },
    album: { cover_medium: 'med', cover_big: 'big' },
  };

  it('maps a happy-path result without a detail call', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [item] }));
    const [r] = await deezerSearchProvider.search('disclosure latch');
    expect(r).toMatchObject({
      provider: 'deezer',
      providerId: '75526535',
      artist: 'Disclosure',
      artists: ['Disclosure'],
      title: 'Latch',
      durationMs: 257000,
      artworkUrl: 'big',
      previewUrl: 'https://p/x.mp3',
      isrc: 'GBUM71302810',
      explicit: false,
    });
    expect(r.releaseDate).toBeUndefined();
    expect(r.popularity).toBeGreaterThan(90);
    expect(r.popularity).toBeLessThanOrEqual(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('limit=25');
  });

  it('leaves isrc undefined when search omits it', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ ...item, isrc: undefined }] }));
    const [r] = await deezerSearchProvider.search('q');
    expect(r.isrc).toBeUndefined();
  });

  it('log-scales rank monotonically into 0..100', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ data: [{ ...item, rank: 10 }, { ...item, rank: 1000 }, { ...item, rank: 1e9 }, { ...item, rank: 0 }] })
    );
    const pops = (await deezerSearchProvider.search('q')).map((r) => r.popularity);
    expect(pops[0]!).toBeLessThan(pops[1]!);
    expect(pops[1]!).toBeLessThan(100);
    expect(pops[2]).toBe(100);
    expect(pops[3]).toBeUndefined();
  });

  it('returns [] when there are no results', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [] }));
    expect(await deezerSearchProvider.search('zzz')).toEqual([]);
  });

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429));
    await expect(deezerSearchProvider.search('x')).rejects.toThrow(/429/);
  });
});

describe('itunes', () => {
  const item = {
    trackId: 1440862129,
    trackName: 'Latch',
    artistName: 'Disclosure & Sam Smith',
    trackTimeMillis: 255000,
    releaseDate: '2013-06-03T07:00:00Z',
    previewUrl: 'https://a/p.m4a',
    artworkUrl100: 'https://is1/x/100x100bb.jpg',
  };

  it('maps a happy-path result', async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [item] }));
    const [r] = await itunesSearchProvider.search('disclosure latch');
    expect(r).toMatchObject({
      provider: 'itunes',
      providerId: '1440862129',
      artist: 'Disclosure & Sam Smith',
      title: 'Latch',
      durationMs: 255000,
      releaseDate: '2013-06-03',
      previewUrl: 'https://a/p.m4a',
      artworkUrl: 'https://is1/x/600x600bb.jpg',
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('media=music');
    expect(url).toContain('entity=song');
    expect(url).toContain('limit=25');
  });

  it('returns [] when there are no results', async () => {
    fetchMock.mockResolvedValueOnce(json({ resultCount: 0, results: [] }));
    expect(await itunesSearchProvider.search('zzz')).toEqual([]);
  });

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 403));
    await expect(itunesSearchProvider.search('x')).rejects.toThrow(/403/);
  });
});
