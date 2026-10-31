import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolver: { searchTracks: vi.fn(), resolveTrack: vi.fn(), getSimilarTracks: vi.fn() },
  auth: { getCurrentUser: vi.fn() },
  server: { createClient: vi.fn() },
  admin: { createAdminClient: vi.fn() },
  entitlements: {
    canCreatePlaylist: vi.fn(),
    EntitlementsUnavailableError: class EntitlementsUnavailableError extends Error {},
  },
}));
vi.mock('@/lib/supabase/admin', () => mocks.admin);
vi.mock('@/lib/billing/entitlements', () => mocks.entitlements);
vi.mock('@/lib/resolver', () => mocks.resolver);
vi.mock('@/lib/supabase/auth', () => mocks.auth);
vi.mock('@/lib/supabase/server', () => mocks.server);

describe('GET /api/search', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns an empty list for a blank query without calling the resolver', async () => {
    const { GET } = await import('@/app/api/search/route');
    const body = await (await GET(new Request('http://x/api/search?q=%20'))).json();
    expect(body.tracks).toEqual([]);
    expect(mocks.resolver.searchTracks).not.toHaveBeenCalled();
  });

  it('proxies to searchTracks', async () => {
    mocks.resolver.searchTracks.mockResolvedValue([{ id: 'x', artist: 'A', title: 'B', sources: {} }]);
    const { GET } = await import('@/app/api/search/route');
    const body = await (await GET(new Request('http://x/api/search?q=lane'))).json();
    expect(mocks.resolver.searchTracks).toHaveBeenCalledWith('lane');
    expect(body.tracks.map((t: { id: string }) => t.id)).toEqual(['x']);
  });

  it('carries the version label and duration of each hit', async () => {
    mocks.resolver.searchTracks.mockResolvedValue([
      { id: 'x', artist: 'CamelPhat', title: 'Cola (Extended Mix)', version: 'Extended Mix', durationMs: 401_000, sources: {} },
    ]);
    const { GET } = await import('@/app/api/search/route');
    const body = await (await GET(new Request('http://x/api/search?q=cola'))).json();
    expect(body.tracks[0]).toMatchObject({ version: 'Extended Mix', durationMs: 401_000 });
  });

  it('falls back to demo search when the resolver throws', async () => {
    mocks.resolver.searchTracks.mockRejectedValue(new Error('offline'));
    const { GET } = await import('@/app/api/search/route');
    const body = await (await GET(new Request('http://x/api/search?q=lane%208'))).json();
    expect(body.tracks.length).toBeGreaterThan(0);
    expect(body.tracks.every((t: { artist: string }) => t.artist === 'Lane 8')).toBe(true);
  });
});

describe('/api/playlists', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.resetAllMocks();
  });

  it('answers 501 with a demo flag in demo mode (GET and POST)', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const { GET, POST } = await import('@/app/api/playlists/route');
    const g = await GET();
    expect(g.status).toBe(501);
    expect((await g.json()).demo).toBe(true);
    const p = await POST(new Request('http://x', { method: 'POST', body: '{}' }));
    expect(p.status).toBe(501);
    expect(mocks.auth.getCurrentUser).not.toHaveBeenCalled();
  });

  it('requires sign-in when Supabase is configured', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    mocks.auth.getCurrentUser.mockResolvedValue(null);
    mocks.server.createClient.mockResolvedValue({});
    const { GET } = await import('@/app/api/playlists/route');
    expect((await GET()).status).toBe(401);
  });
});

describe('playlist row mapping', () => {
  it('round-trips a partial track without inventing values', async () => {
    const { rowToTrack, trackToRow } = await import('@/app/api/playlists/mapping');
    const t = { id: 'demo-1', artist: 'A', title: 'B', bpm: 124, sources: { bpm: 'demo-seed' } };
    const row = trackToRow(t);
    expect(row.energy).toBeNull();
    const back = rowToTrack({ ...row, created_at: 'now' } as Parameters<typeof rowToTrack>[0]);
    expect(back).toMatchObject(t);
    expect(back.energy).toBeUndefined();
  });
});

describe('sanitizeTrack (shared-catalogue input validation)', () => {
  it('keeps valid fields and drops out-of-range / wrong-type ones', async () => {
    const { sanitizeTrack } = await import('@/components/trackSanitize');
    const t = sanitizeTrack({
      id: 'x1',
      artist: 'A',
      title: 'B',
      bpm: '128',
      camelot: '13A',
      energy: 11,
      danceability: 0.7,
      popularity: 101,
      year: 2019.5,
      isrc: 'GBUM71029604',
      sources: { bpm: 'deezer', danceability: 'soundstat', evil: 'x', energy: 'spoof' },
    });
    expect(t).toEqual({
      id: 'x1',
      artist: 'A',
      title: 'B',
      danceability: 0.7,
      isrc: 'GBUM71029604',
      sources: { danceability: 'soundstat' },
    });
    expect(sanitizeTrack({ id: 'x', artist: 'A', title: 'B', bpm: 128, camelot: '12B', energy: 1 })).toMatchObject({
      bpm: 128,
      camelot: '12B',
      energy: 1,
    });
    for (const bad of ['0A', '1C', '8a', ' 8A', '12AB']) {
      expect(sanitizeTrack({ id: 'x', artist: 'A', title: 'B', camelot: bad })?.camelot).toBeUndefined();
    }
  });

  it('accepts only http(s) URLs', async () => {
    const { sanitizeTrack } = await import('@/components/trackSanitize');
    const t = sanitizeTrack({
      id: 'x',
      artist: 'A',
      title: 'B',
      previewUrl: 'https://audio-ssl.itunes.apple.com/p.m4a',
      itunesUrl: 'javascript:alert(1)',
      youtubeUrl: 'data:text/html,<script>1</script>',
      artworkUrl: '//evil.example/x.png',
    });
    expect(t?.previewUrl).toBe('https://audio-ssl.itunes.apple.com/p.m4a');
    expect(t?.itunesUrl).toBeUndefined();
    expect(t?.youtubeUrl).toBeUndefined();
    expect(t?.artworkUrl).toBeUndefined();
  });

  it('rejects tracks without usable identity fields', async () => {
    const { sanitizeTrack } = await import('@/components/trackSanitize');
    expect(sanitizeTrack({ id: 'x', artist: '', title: 'B' })).toBeNull();
    expect(sanitizeTrack({ id: 5, artist: 'A', title: 'B' })).toBeNull();
    expect(sanitizeTrack('junk')).toBeNull();
  });

  it('youtube link-out never uses a non-http URL', async () => {
    const { youtubeHref } = await import('@/components/trackFormat');
    expect(youtubeHref({ id: 'x', artist: 'A', title: 'B', youtubeUrl: 'javascript:alert(1)', sources: {} })).toBe(
      'https://www.youtube.com/results?search_query=A%20B'
    );
  });
});

describe('POST /api/playlists (configured)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.resetAllMocks();
  });

  it('inserts only unknown catalogue ids (never overwrites) with sanitized rows', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    mocks.auth.getCurrentUser.mockResolvedValue({ id: 'u1', email: null, isAdmin: false });
    mocks.entitlements.canCreatePlaylist.mockResolvedValue(true);

    const upsert = vi.fn(async () => ({ error: null }));
    mocks.admin.createAdminClient.mockReturnValue({ from: vi.fn(() => ({ upsert })) });

    const single = vi.fn(async () => ({
      data: { id: 'p1', name: 'My set', arc_template: '60min', created_at: 'now', user_id: 'u1' },
      error: null,
    }));
    const entriesInsert = vi.fn(async () => ({ error: null }));
    mocks.server.createClient.mockResolvedValue({
      from: vi.fn((table: string) =>
        table === 'playlists'
          ? { insert: vi.fn(() => ({ select: vi.fn(() => ({ single })) })) }
          : { insert: entriesInsert }
      ),
    });

    const { POST } = await import('@/app/api/playlists/route');
    const res = await POST(
      new Request('http://x/api/playlists', {
        method: 'POST',
        body: JSON.stringify({
          name: 'My set',
          template: '60min',
          tracks: [
            { id: 'demo-001', artist: 'Lane 8', title: 'Brightest Lights', bpm: 1, camelot: 'x', youtubeUrl: 'javascript:alert(1)', sources: {} },
            { nope: true },
          ],
        }),
      })
    );
    expect(res.status).toBe(201);
    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = upsert.mock.calls[0] as unknown as [Array<Record<string, unknown>>, Record<string, unknown>];
    expect(opts).toEqual({ onConflict: 'id', ignoreDuplicates: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'demo-001', bpm: null, camelot: null, youtube_url: null, preview_url: null });
    expect(entriesInsert).toHaveBeenCalledWith([{ playlist_id: 'p1', position: 0, track_id: 'demo-001' }]);
  });

  it('returns 503 when entitlements are unavailable', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    mocks.auth.getCurrentUser.mockResolvedValue({ id: 'u1', email: null, isAdmin: false });
    mocks.server.createClient.mockResolvedValue({});
    mocks.entitlements.canCreatePlaylist.mockRejectedValue(new mocks.entitlements.EntitlementsUnavailableError('down'));
    const { POST } = await import('@/app/api/playlists/route');
    const res = await POST(new Request('http://x/api/playlists', { method: 'POST', body: JSON.stringify({ name: 'a', tracks: [] }) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'entitlements unavailable' });
  });
});
