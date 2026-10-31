import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spotifySearchProvider, deezerSearchProvider, itunesSearchProvider } from '@/lib/search/providers';
import { resetSpotifyTokenCache } from '@/lib/sources/spotify';

// Uses the REAL parseVersion; only fetch is mocked.
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

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

describe('providers with real parseVersion', () => {
  it.each(['Extended Mix', '(Extended Mix)'])('deezer title_version %s -> extended', async (tv) => {
    fetchMock.mockResolvedValueOnce(
      json({ data: [{ id: 1, title: 'Latch', title_version: tv, artist: { name: 'Disclosure' } }] })
    );
    const [r] = await deezerSearchProvider.search('latch');
    expect(r.title).toBe('Latch');
    expect(r.version.kind).toBe('extended');
    expect(r.version.baseTitle).toBe('Latch');
  });

  it('spotify bracketed title -> extended', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 't', expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(
      json({ tracks: { items: [{ id: 's1', name: 'Latch (Extended Mix)', artists: [{ name: 'Disclosure' }] }] } })
    );
    const [r] = await spotifySearchProvider.search('latch');
    expect(r.version.kind).toBe('extended');
    expect(r.version.baseTitle).toBe('Latch');
  });

  it('itunes dashed title -> extended', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ results: [{ trackId: 9, trackName: 'Latch - Extended Mix', artistName: 'Disclosure' }] })
    );
    const [r] = await itunesSearchProvider.search('latch');
    expect(r.version.kind).toBe('extended');
    expect(r.version.baseTitle).toBe('Latch');
  });
});
