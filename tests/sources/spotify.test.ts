import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSpotifyTokenCache, spotifyAdapter } from '@/lib/sources/spotify';
import { base, json, mockFetch } from './helpers';

const hit = {
  id: 'SP1',
  name: 'One More Time',
  popularity: 77,
  external_urls: { spotify: 'https://open.spotify.com/track/SP1' },
  external_ids: { isrc: 'ISRC9' },
  artists: [{ name: 'Daft Punk' }],
};
const tokenRoute: [string, () => Response] = [
  'accounts.spotify.com/api/token',
  () => json({ access_token: 'tok', expires_in: 3600 }),
];

beforeEach(() => {
  resetSpotifyTokenCache();
  vi.stubEnv('SPOTIFY_CLIENT_ID', 'id');
  vi.stubEnv('SPOTIFY_CLIENT_SECRET', 'secret');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('spotify', () => {
  it('configured only with both credentials', () => {
    expect(spotifyAdapter.configured()).toBe(true);
    vi.stubEnv('SPOTIFY_CLIENT_SECRET', '');
    expect(spotifyAdapter.configured()).toBe(false);
  });

  it('maps id, url, popularity and isrc from the matching hit', async () => {
    const f = mockFetch([tokenRoute, ['api.spotify.com/v1/search', () => json({ tracks: { items: [hit] } })]]);
    expect(await spotifyAdapter.enrich(base())).toEqual({
      artist: 'Daft Punk',
      title: 'One More Time',
      spotifyId: 'SP1',
      spotifyUrl: 'https://open.spotify.com/track/SP1',
      popularity: 77,
      isrc: 'ISRC9',
    });
    const search = String(f.mock.calls[1][0]);
    expect(search).toContain('type=track&limit=5&q=Daft%20Punk%20One%20More%20Time');
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ method: 'POST' });
  });

  it('does not overwrite popularity/isrc already known', async () => {
    mockFetch([tokenRoute, ['api.spotify.com', () => json({ tracks: { items: [hit] } })]]);
    const out = await spotifyAdapter.enrich(base({ popularity: 10, isrc: 'X' }));
    expect(out).toEqual({ artist: 'Daft Punk', title: 'One More Time', spotifyId: 'SP1', spotifyUrl: 'https://open.spotify.com/track/SP1' });
  });

  it('artist mismatch → {}', async () => {
    mockFetch([
      tokenRoute,
      ['api.spotify.com', () => json({ tracks: { items: [{ ...hit, artists: [{ name: 'Someone Else' }] }] } })],
    ]);
    expect(await spotifyAdapter.enrich(base())).toEqual({});
  });

  it('caches the token across calls', async () => {
    const f = mockFetch([tokenRoute, ['api.spotify.com', () => json({ tracks: { items: [hit] } })]]);
    await spotifyAdapter.enrich(base());
    await spotifyAdapter.enrich(base());
    expect(f.mock.calls.filter(([u]) => String(u).includes('/api/token'))).toHaveLength(1);
  });

  it('refreshes the token once on 401', async () => {
    let searches = 0;
    const f = mockFetch([
      tokenRoute,
      ['api.spotify.com', () => (searches++ === 0 ? json({}, 401) : json({ tracks: { items: [hit] } }))],
    ]);
    expect((await spotifyAdapter.enrich(base())).spotifyId).toBe('SP1');
    expect(f.mock.calls.filter(([u]) => String(u).includes('/api/token'))).toHaveLength(2);
  });

  it('persistent 401 / 429 / 5xx → throws', async () => {
    for (const status of [401, 429, 503]) {
      resetSpotifyTokenCache();
      mockFetch([tokenRoute, ['api.spotify.com', () => json({}, status)]]);
      await expect(spotifyAdapter.enrich(base())).rejects.toThrow();
    }
  });

  it('a hit by the right artist but a different song is rejected (no spotifyId, so ReccoBeats never reads the wrong song)', async () => {
    mockFetch([tokenRoute, ['api.spotify.com', () => json({ tracks: { items: [{ ...hit, id: 'WRONG', name: 'Aerodynamic' }] } })]]);
    expect(await spotifyAdapter.enrich(base())).toEqual({});
  });
  it('takes the matching song when a different one by the same artist ranks first', async () => {
    mockFetch([tokenRoute, ['api.spotify.com', () => json({ tracks: { items: [{ ...hit, id: 'WRONG', name: 'Aerodynamic' }, { ...hit, name: 'One More Time - Radio Edit' }] } })]]);
    expect((await spotifyAdapter.enrich(base())).spotifyId).toBe('SP1');
  });
});
