import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open, seal, SESSION_COOKIE, STATE_COOKIE } from '@/lib/spotify/cookie';
import { createPlaylist, listPlaylists, playlistTracks } from '@/lib/spotify/api';
import { getSpotifySession } from '@/lib/spotify/session';
import { GET as login } from '@/app/api/spotify/login/route';
import { GET as callback } from '@/app/api/spotify/callback/route';
import { GET as status } from '@/app/api/spotify/status/route';
import { POST as exportRoute } from '@/app/api/spotify/export/route';
import { DELETE as disconnect } from '@/app/api/spotify/session/route';

const json = (body: unknown, ok = true, statusCode = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: ok ? statusCode : statusCode,
    })
  );

const sessionCookie = (
  over: Partial<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> = {}
) => `${SESSION_COOKIE}=${seal({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 600_000, ...over })}`;
const req = (url: string, cookie?: string, init: RequestInit = {}) =>
  new Request(url, {
    ...init,
    headers: { ...(cookie ? { cookie } : {}), ...(init.headers as object) },
  });

const fetchMock = vi.fn();
beforeEach(() => {
  process.env.SPOTIFY_CLIENT_ID = 'cid';
  process.env.SPOTIFY_CLIENT_SECRET = 'csecret';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('cookie crypto', () => {
  it('round-trips and rejects tampering', () => {
    const s = seal({ a: 1 });
    expect(open(s)).toEqual({ a: 1 });
    expect(open(s.slice(0, -2) + 'AA')).toBeNull();
    expect(open('garbage')).toBeNull();
  });
});

describe('login', () => {
  it('redirects to Spotify with scopes, state cookie and origin-derived redirect_uri', async () => {
    for (const origin of ['http://localhost:3000', 'http://localhost:3001']) {
      const res = await login(req(`${origin}/api/spotify/login`));
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.origin + loc.pathname).toBe('https://accounts.spotify.com/authorize');
      expect(loc.searchParams.get('redirect_uri')).toBe(`${origin}/api/spotify/callback`);
      expect(loc.searchParams.get('scope')).toBe(
        'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private'
      );
      const state = loc.searchParams.get('state')!;
      const setCookie = res.headers.get('set-cookie')!;
      expect(setCookie).toContain(`${STATE_COOKIE}=${state}`);
      expect(setCookie).toContain('HttpOnly');
    }
  });
  it('503 when not configured', async () => {
    delete process.env.SPOTIFY_CLIENT_ID;
    expect((await login(req('http://localhost:3000/api/spotify/login'))).status).toBe(503);
  });
});

describe('callback', () => {
  it('rejects a state mismatch without calling Spotify', async () => {
    const res = await callback(
      req('http://localhost:3000/api/spotify/callback?code=c&state=bad', `${STATE_COOKIE}=good`)
    );
    expect(res.headers.get('location')).toContain('spotify=error');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('exchanges the code and stores an encrypted httpOnly cookie', async () => {
    fetchMock.mockImplementation(() => json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }));
    const res = await callback(req('http://localhost:3001/api/spotify/callback?code=c&state=s', `${STATE_COOKIE}=s`));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/');
    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fapi%2Fspotify%2Fcallback');
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(SESSION_COOKIE))!;
    expect(session).toContain('HttpOnly');
    expect(session).not.toContain('AT');
    const value = session.split(';')[0].split('=')[1];
    expect(open<{ accessToken: string; refreshToken: string }>(value)).toMatchObject({
      accessToken: 'AT',
      refreshToken: 'RT',
    });
  });
});

describe('getSpotifySession', () => {
  it('null when not connected', async () => {
    expect(await getSpotifySession(req('http://x/'))).toBeNull();
  });
  it('returns the stored token while fresh', async () => {
    expect(await getSpotifySession(req('http://x/', sessionCookie()))).toEqual({
      accessToken: 'AT',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('refreshes an expired token and hands back a new cookie', async () => {
    fetchMock.mockImplementation(() => json({ access_token: 'AT2', expires_in: 3600 }));
    const s = await getSpotifySession(req('http://x/', sessionCookie({ expiresAt: 1 })));
    expect(s?.accessToken).toBe('AT2');
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('grant_type=refresh_token');
    const stored = open<{ refreshToken: string }>(s!.setCookie!.split(';')[0].split('=')[1]);
    expect(stored?.refreshToken).toBe('RT');
  });
});

describe('api mapping', () => {
  it('maps playlist items, joins artists, skips local/null tracks, follows pagination', async () => {
    fetchMock
      .mockImplementationOnce(() =>
        json({
          items: [
            {
              track: {
                id: 'abc',
                name: 'Song',
                popularity: 55,
                artists: [{ name: 'A' }, { name: 'B' }],
                external_urls: {
                  spotify: 'https://open.spotify.com/track/abc',
                },
              },
            },
            { track: null },
            { track: { id: 'loc', name: 'Local', is_local: true, artists: [] } },
          ],
          next: 'https://api.spotify.com/v1/playlists/p/tracks?offset=100',
        })
      )
      .mockImplementationOnce(() =>
        json({
          items: [{ track: { id: 'def', name: 'Old', artists: [{ name: 'C' }] } }],
          next: null,
        })
      );
    const out = await playlistTracks('tok', 'p');
    expect(out).toEqual([
      {
        artist: 'A, B',
        title: 'Song',
        spotifyId: 'abc',
        spotifyUrl: 'https://open.spotify.com/track/abc',
        popularity: 55,
      },
      {
        artist: 'C',
        title: 'Old',
        spotifyId: 'def',
        spotifyUrl: undefined,
        popularity: undefined,
      },
    ]);
  });
  it('drops playlists repeated across pages and tracks repeated within a playlist (unique React keys)', async () => {
    fetchMock
      .mockImplementationOnce(() =>
        json({
          items: [{ id: 'p1', name: 'One', tracks: { total: 2 } }],
          next: 'https://api.spotify.com/v1/me/playlists?offset=50',
        })
      )
      .mockImplementationOnce(() =>
        json({
          items: [
            { id: 'p1', name: 'One', tracks: { total: 2 } },
            { id: 'p2', name: 'Two', tracks: { total: 0 } },
          ],
          next: null,
        })
      );
    expect((await listPlaylists('tok')).map((p) => p.id)).toEqual(['p1', 'p2']);

    fetchMock.mockImplementationOnce(() =>
      json({
        items: [
          { track: { id: 'abc', name: 'Song', artists: [{ name: 'A' }] } },
          { track: { id: 'abc', name: 'Song', artists: [{ name: 'A' }] } },
        ],
        next: null,
      })
    );
    expect((await playlistTracks('tok', 'p1')).map((t) => t.spotifyId)).toEqual(['abc']);
  });
  it('never touches deprecated endpoints', async () => {
    fetchMock.mockImplementation(() => json({ items: [], next: null, id: 'p1' }));
    await playlistTracks('t', 'p');
    await createPlaylist('t', 'n', ['a'.repeat(22)]);
    for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toMatch(/audio-features|recommendations/);
  });
  it('createPlaylist chunks track uris by 100 and returns the url', async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).endsWith('/me/playlists')
        ? json({
            id: 'pl',
            external_urls: { spotify: 'https://open.spotify.com/playlist/pl' },
          })
        : json({})
    );
    const ids = Array.from({ length: 150 }, (_, i) => `id${i}`);
    expect(await createPlaylist('t', 'Set', ids)).toBe('https://open.spotify.com/playlist/pl');
    const adds = fetchMock.mock.calls.filter(([, i]) => i.method === 'POST').slice(1);
    expect(adds).toHaveLength(2);
    expect(JSON.parse(adds[0][1].body).uris[0]).toBe('spotify:track:id0');
  });
});

describe('routes', () => {
  it('status reports disconnected / connected', async () => {
    expect(await (await status(req('http://x/api/spotify/status'))).json()).toEqual({ connected: false });
    fetchMock.mockImplementation(() => json({ id: 'u', display_name: 'DJ Zed' }));
    expect(await (await status(req('http://x/api/spotify/status', sessionCookie()))).json()).toEqual({
      connected: true,
      displayName: 'DJ Zed',
    });
  });
  it('export validates input and requires a session', async () => {
    const post = (body: unknown, cookie?: string) =>
      exportRoute(
        req('http://x/api/spotify/export', cookie, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      );
    expect((await post({ name: '', spotifyIds: [] }, sessionCookie())).status).toBe(400);
    expect((await post({ name: 'n', spotifyIds: ['abcdefghij12'] })).status).toBe(401);
    fetchMock.mockImplementation(() =>
      json({
        id: 'pl',
        external_urls: { spotify: 'https://open.spotify.com/playlist/pl' },
      })
    );
    const ok = await post({ name: 'n', spotifyIds: ['abcdefghij12'] }, sessionCookie());
    expect(await ok.json()).toEqual({
      url: 'https://open.spotify.com/playlist/pl',
    });
  });
  it('disconnect clears the session cookie', async () => {
    const res = await disconnect();
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`${SESSION_COOKIE}=;.*Max-Age=0`));
  });
});

describe('hardening', () => {
  it('SPOTIFY_REDIRECT_URI overrides the request origin in login and callback', async () => {
    process.env.SPOTIFY_REDIRECT_URI = 'https://app.example/api/spotify/callback';
    try {
      const res = await login(req('http://evil.test/api/spotify/login'));
      expect(new URL(res.headers.get('location')!).searchParams.get('redirect_uri')).toBe(
        'https://app.example/api/spotify/callback'
      );
      fetchMock.mockImplementation(() => json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }));
      const cb = await callback(req('http://evil.test/api/spotify/callback?code=c&state=s', `${STATE_COOKIE}=s`));
      expect(String(fetchMock.mock.calls[0][1].body)).toContain(
        encodeURIComponent('https://app.example/api/spotify/callback')
      );
      expect(new URL(cb.headers.get('location')!).origin).toBe('https://app.example');
    } finally {
      delete process.env.SPOTIFY_REDIRECT_URI;
    }
  });
  it('hops to the callback origin when the request Host differs (localhost vs 127.0.0.1)', async () => {
    process.env.SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:3001/api/spotify/callback';
    try {
      const res = await login(
        req('http://localhost:3001/api/spotify/login', undefined, { headers: { host: 'localhost:3001' } })
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('http://127.0.0.1:3001/api/spotify/login');
      // and no state cookie is set on the wrong origin
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      delete process.env.SPOTIFY_REDIRECT_URI;
    }
  });
  it('maps a blocked (editorial/followed) playlist to a friendly 403', async () => {
    fetchMock.mockImplementationOnce(() => new Response('', { status: 404 }));
    await expect(playlistTracks('tok', 'p')).rejects.toMatchObject({ name: 'PlaylistBlockedError' });
  });
  it('refuses to send the token to a non-Spotify pagination URL', async () => {
    fetchMock.mockImplementationOnce(() => json({ items: [], next: 'https://evil.test/steal' }));
    await expect(playlistTracks('tok', 'p')).rejects.toThrow(/non-Spotify/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed playlist ids with 400', async () => {
    const { GET: tracksRoute } = await import('@/app/api/spotify/playlists/[id]/tracks/route');
    for (const id of ['..', 'a/b', 'short']) {
      const res = await tracksRoute(req('http://x/', sessionCookie()), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
    }
  });
  it('marks authenticated responses no-store', async () => {
    fetchMock.mockImplementation(() => json({ id: 'u', display_name: 'X' }));
    const res = await status(req('http://x/api/spotify/status', sessionCookie()));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
