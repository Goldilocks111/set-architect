import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapterHealth, resolveTrack, searchTracks } from '@/lib/resolver';
import { configureMusicBrainzLimiter } from '@/lib/sources/musicbrainz';
import { json, mockFetch } from './helpers';

const deezerHit = { id: 1, title: 'T', rank: 500000, preview: 'dz-preview', artist: { name: 'A' } };
const itunesHit = { trackId: 2, trackName: 'T', artistName: 'A', previewUrl: 'it-preview', trackViewUrl: 'it-url' };

beforeEach(() => {
  configureMusicBrainzLimiter(0);
  for (const k of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'GETSONGBPM_API_KEY', 'SOUNDSTAT_API_KEY', 'YOUTUBE_API_KEY', 'LASTFM_API_KEY'])
    vi.stubEnv(k, '');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('resolveTrack', () => {
  it('spotify supplies spotifyId in the same pass so reccobeats provides energy', async () => {
    vi.stubEnv('SPOTIFY_CLIENT_ID', 'id');
    vi.stubEnv('SPOTIFY_CLIENT_SECRET', 'secret');
    mockFetch([
      ['accounts.spotify.com', () => json({ access_token: 't', expires_in: 3600 })],
      [
        'api.spotify.com',
        () => json({ tracks: { items: [{ id: 'SPX', artists: [{ name: 'A' }], external_urls: { spotify: 'https://open.spotify.com/track/SPX' } }] } }),
      ],
      ['api.reccobeats.com/v1/audio-features?ids=SPX', () => json({ content: [{ tempo: 124, energy: 1 }] })],
      ['api.deezer.com', () => json({ data: [] })],
      ['itunes.apple.com', () => json({ results: [] })],
    ]);
    const t = await resolveTrack('A', 'T');
    expect(t.spotifyId).toBe('SPX');
    expect(t.spotifyUrl).toBe('https://open.spotify.com/track/SPX');
    expect(t.energy).toBe(10);
    expect(t.sources.energy).toBe('reccobeats');
  });

  it('merges partials: first source wins per field, with provenance', async () => {
    mockFetch([
      ['api.deezer.com/track', () => json({ ...deezerHit, isrc: 'ISRC1' })],
      ['api.deezer.com/search', () => json({ data: [deezerHit] })],
      ['itunes.apple.com', () => json({ results: [itunesHit] })],
      ['api.reccobeats.com/v1/audio-features', () => json({ content: [{ tempo: 124, key: 9, mode: 0, energy: 0.6 }] })],
    ]);
    const t = await resolveTrack('A', 'T', { spotifyId: 'SP1' });
    expect(t.previewUrl).toBe('it-preview'); // iTunes preferred over Deezer
    expect(t.sources.previewUrl).toBe('itunes');
    expect(t.sources.popularity).toBe('deezer');
    expect(t.itunesUrl).toBe('it-url');
    expect(t.sources.itunesUrl).toBe('itunes');
    expect(t.isrc).toBe('ISRC1');
    expect(t.bpm).toBe(124);
    expect(t.sources.bpm).toBe('reccobeats');
    expect(t.camelot).toBe('8A');
    expect(t.youtubeUrl).toContain('youtube.com/results');
    expect(t.sources.youtubeUrl).toBe('youtube');
  });

  it('falls back to the Deezer preview when iTunes fails', async () => {
    mockFetch([
      ['api.deezer.com', () => json({ data: [deezerHit] })],
      ['itunes.apple.com', () => json({}, 500)],
    ]);
    const t = await resolveTrack('A', 'T');
    expect(t.previewUrl).toBe('dz-preview');
    expect(t.sources.previewUrl).toBe('deezer');
  });

  it('soundstat overrides earlier bpm/camelot but not other fields', async () => {
    vi.stubEnv('GETSONGBPM_API_KEY', 'g');
    vi.stubEnv('SOUNDSTAT_API_KEY', 's');
    mockFetch([
      ['api.getsong.co', () => json({ search: [{ tempo: '120', key_of: 'Am' }] })],
      ['soundstat.info', () => json({ features: { tempo: 126, key: 0, mode: 1, energy: 0.5 } })],
    ]);
    const t = await resolveTrack('A', 'T', { spotifyId: 'SP1' });
    expect(t.bpm).toBe(126);
    expect(t.sources.bpm).toBe('soundstat');
    expect(t.camelot).toBe('8B');
    expect(t.energy).toBe(6);
  });

  it('skips unconfigured keyed adapters without fetching them', async () => {
    const f = mockFetch([]);
    await resolveTrack('A', 'T');
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('getsong.co') || u.includes('soundstat'))).toBe(false);
  });

  it('all adapters failing still returns a best-effort Track and never rejects', async () => {
    mockFetch([]); // every fetch rejects
    const t = await resolveTrack('Some Artist', 'Some Title');
    expect(t.id).toBe('some artist|some title');
    expect(t).toMatchObject({ artist: 'Some Artist', title: 'Some Title' });
    // youtube is keyless and offline, so it alone contributes
    expect(Object.keys(t.sources)).toEqual(['youtubeUrl']);
  });

  it('one failing adapter does not block the others', async () => {
    mockFetch([
      ['api.deezer.com', () => json({}, 500)],
      ['itunes.apple.com', () => json({ results: [itunesHit] })],
    ]);
    const t = await resolveTrack('A', 'T');
    expect(t.previewUrl).toBe('it-preview');
    expect(t.sources.previewUrl).toBe('itunes');
  });

  it('a hung adapter is abandoned after 4s and resolution continues', async () => {
    vi.useFakeTimers();
    mockFetch([
      ['api.deezer.com', () => new Promise<Response>(() => {})], // never settles, ignores abort
      ['itunes.apple.com', () => json({ results: [itunesHit] })],
    ]);
    const p = resolveTrack('A', 'T');
    await vi.advanceTimersByTimeAsync(3900);
    let settled = false;
    p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const t = await p;
    expect(t.previewUrl).toBe('it-preview');
  });
});

describe('searchTracks', () => {
  it('merges provider hits into one version-labelled track per recording', async () => {
    mockFetch([
      [
        'api.deezer.com',
        () =>
          json({
            data: [
              { ...deezerHit, title: 'T', title_version: 'Extended Mix', isrc: 'GBAAA2400001', duration: 400 },
              { ...deezerHit, id: 3, title: 'T (B Remix)', duration: 380 },
            ],
          }),
      ],
      ['itunes.apple.com', () => json({ results: [{ ...itunesHit, trackName: 'T (Extended Mix)', trackTimeMillis: 400_500 }] })],
    ]);
    // title-only: not a full answer from Deezer, so iTunes is asked as well
    const res = await searchTracks('t');
    expect(res).toHaveLength(2);
    const ext = res.find((t) => t.version === 'Extended Mix')!;
    expect(ext).toMatchObject({ id: 'isrc-GBAAA2400001', title: 'T (Extended Mix)', durationMs: 400_000, previewUrl: 'it-preview' });
    expect(res.find((t) => t.version === 'B Remix')?.title).toBe('T (B Remix)');
  });
  it('still answers when one provider fails', async () => {
    mockFetch([
      ['api.deezer.com', () => json({}, 403)],
      ['itunes.apple.com', () => json({ results: [itunesHit] })],
    ]);
    const [t] = await searchTracks('a t');
    expect(t).toMatchObject({ artist: 'A', title: 'T' });
    expect(t.version).toBeUndefined();
  });
  it('falls back to the demo seed when every provider fails', async () => {
    mockFetch([]);
    const res = await searchTracks('Lane 8');
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].artist).toBe('Lane 8');
  });
  it('returns [] (not demo) when providers answer but nothing matches', async () => {
    mockFetch([
      ['api.deezer.com', () => json({ data: [] })],
      ['itunes.apple.com', () => json({ results: [] })],
    ]);
    expect(await searchTracks('zzzz')).toEqual([]);
  });
});

describe('adapterHealth', () => {
  it('reports configured state from env', () => {
    vi.stubEnv('SOUNDSTAT_API_KEY', 's');
    const h = Object.fromEntries(adapterHealth().map((a) => [a.name, a.configured]));
    expect(h.deezer).toBe(true);
    expect(h.soundstat).toBe(true);
    expect(h.getsongbpm).toBe(false);
    expect(h.lastfm).toBe(false);
  });
});

describe('resolveTrack metadata chain', () => {
  it('deezer isrc -> musicbrainz mbid -> acousticbrainz bpm/key, with estimate provenance', async () => {
    mockFetch([
      ['api.deezer.com/track', () => json({ ...deezerHit, isrc: 'ISRC1' })],
      ['api.deezer.com/search', () => json({ data: [deezerHit] })],
      ['itunes.apple.com', () => json({ results: [] })],
      ['musicbrainz.org/ws/2/isrc/ISRC1', () => json({ recordings: [{ id: 'mb-1' }] })],
      ['acousticbrainz.org/api/v1/low-level', () =>
        json({ 'mb-1': { '0': { rhythm: { bpm: 126.04 }, tonal: { key_key: 'A', key_scale: 'minor' }, lowlevel: { average_loudness: 0.5 } } } })],
      ['acousticbrainz.org/api/v1/high-level', () => json({})],
    ]);
    const t = await resolveTrack('A', 'T');
    expect(t.mbid).toBe('mb-1');
    expect(t.sources.mbid).toBe('musicbrainz');
    expect(t.bpm).toBe(126);
    expect(t.sources.bpm).toBe('acousticbrainz');
    expect(t.camelot).toBe('8A');
    expect(t.energy).toBe(6);
    expect(t.sources.energy).toBe('acousticbrainz-estimate');
  });

  it('lists musicbrainz and acousticbrainz after reccobeats in adapter health', () => {
    const names = adapterHealth().map((a) => a.name);
    expect(names.indexOf('musicbrainz')).toBeGreaterThan(names.indexOf('reccobeats'));
    expect(names.indexOf('acousticbrainz')).toBeGreaterThan(names.indexOf('musicbrainz'));
  });
});
