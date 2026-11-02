import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseVersion } from '@/lib/search/version';
import type { MergedHit, SearchProvider, SearchResult } from '@/lib/search/types';
import { trackKeyOf, type Track } from '@/types/track';
import { sanitizeTrack } from '@/components/trackSanitize';
import { playlistReducer } from '@/components/playlistReducer';
import { recordingKeys } from '@/components/recordingKeys';

type Name = SearchResult['provider'];
const res = (provider: Name, artist: string, title: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  provider,
  providerId: `${provider}-${title}`,
  artist,
  artists: [artist],
  title,
  version: parseVersion(title, [artist]),
  ...extra,
});
const prov = (name: Name, results: SearchResult[]) => ({ name, configured: () => true, search: vi.fn(async () => results) }) satisfies SearchProvider;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-'));
  process.env.SETARCHITECT_DATA_DIR = dir;
  vi.resetModules();
});
const cooldownFile = () => path.join(dir, 'search', 'provider-cooldowns.json');

describe('I3: stage timings', () => {
  it('reports stage-1 and total time once per query, flagging a second round', async () => {
    const { mergedSearch } = await import('@/lib/search/merge');
    const onTiming = vi.fn();
    await mergedSearch('camelphat cola', { providers: [prov('spotify', [res('spotify', 'CamelPhat', 'Cola')])], onTiming });
    expect(onTiming).toHaveBeenCalledTimes(1);
    const t = onTiming.mock.calls[0][0];
    expect(t.stage2).toBe(false);
    expect(t.stage1Ms).toBeLessThanOrEqual(t.totalMs);
    await mergedSearch('camelphat cola radio edit', {
      providers: [prov('spotify', [res('spotify', 'CamelPhat', 'Cola')]), prov('itunes', [])],
      onTiming,
    });
    expect(onTiming.mock.calls[1][0].stage2).toBe(true);
  });
});

describe('I4: breaker file shared between processes', () => {
  it('sees a cooldown another process writes after this one has loaded', async () => {
    const b = await import('@/lib/search/breaker');
    expect(b.cooldownUntil('spotify', 1000)).toBe(0);
    fs.mkdirSync(path.dirname(cooldownFile()), { recursive: true });
    fs.writeFileSync(cooldownFile(), JSON.stringify({ spotify: 9_000 }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(cooldownFile(), later, later);
    expect(b.cooldownUntil('spotify', 1000)).toBe(9_000);
  });

  it('merges on write, keeping the larger cooldown per provider', async () => {
    const b = await import('@/lib/search/breaker');
    b.cooldownUntil('spotify', 0); // load (empty)
    fs.mkdirSync(path.dirname(cooldownFile()), { recursive: true });
    fs.writeFileSync(cooldownFile(), JSON.stringify({ spotify: 50_000_000, deezer: 7_000 }));
    const { HttpError } = await import('@/lib/http');
    b.recordFailure('spotify', new HttpError(429, 'u', 1000), 0);
    b.recordFailure('itunes', new HttpError(403, 'u'), 0);
    const onDisk = JSON.parse(fs.readFileSync(cooldownFile(), 'utf8'));
    expect(onDisk).toMatchObject({ spotify: 50_000_000, deezer: 7_000, itunes: b.THROTTLE_COOLDOWN_MS });
  });

  it('resolveTrack skips an adapter whose breaker is open and records its 429', async () => {
    vi.stubEnv('SPOTIFY_CLIENT_ID', 'id');
    vi.stubEnv('SPOTIFY_CLIENT_SECRET', 'secret');
    const fetchMock = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url.includes('api.spotify.com')) return new Response('', { status: 429, headers: { 'Retry-After': '600' } });
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { configureMusicBrainzLimiter } = await import('@/lib/sources/musicbrainz');
    configureMusicBrainzLimiter(0);
    const { resolveTrack } = await import('@/lib/resolver');
    const b = await import('@/lib/search/breaker');
    await resolveTrack('A', 'T');
    expect(b.cooldownUntil('spotify')).toBeGreaterThan(Date.now() + 500_000);
    const spotifyCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('api.spotify.com')).length;
    const before = spotifyCalls();
    await resolveTrack('A', 'T2');
    expect(spotifyCalls()).toBe(before);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe('I5: app-side Spotify discipline', () => {
  it('caps app Spotify calls at 30 a minute, shared by search and enrichment; the bench path is not capped', async () => {
    const b = await import('@/lib/search/breaker');
    for (let i = 0; i < 30; i++) expect(b.takeBudget('spotify', { app: true }, 0)).toBe(true);
    expect(b.takeBudget('spotify', { app: true }, 1)).toBe(false);
    expect(b.takeBudget('spotify', {}, 1)).toBe(true);
    expect(b.takeBudget('spotify', { app: true }, 60_001)).toBe(true);
  });

  it('an app search over the Spotify budget degrades Spotify and still answers from Deezer', async () => {
    const b = await import('@/lib/search/breaker');
    for (let i = 0; i < 30; i++) b.takeBudget('spotify', { app: true });
    const { mergedSearch } = await import('@/lib/search/merge');
    const sp = prov('spotify', [res('spotify', 'CamelPhat', 'Cola')]);
    const out = await mergedSearch('camelphat cola', { providers: [sp, prov('deezer', [res('deezer', 'CamelPhat', 'Cola')])], appBudget: true });
    expect(sp.search).not.toHaveBeenCalled();
    expect(out.degraded).toEqual(['spotify']);
    expect(out.hits).toHaveLength(1);
  });

  it('does not send refined second-round queries for one-word queries', async () => {
    const { mergedSearch } = await import('@/lib/search/merge');
    const sp = prov('spotify', [res('spotify', 'Someone', 'Colab')]);
    await mergedSearch('colab', { providers: [sp] });
    expect(sp.search).toHaveBeenCalledTimes(1);
  });

  it('the search route makes no provider call below 3 characters', async () => {
    const searchTracks = vi.fn(async () => []);
    vi.doMock('@/lib/resolver', () => ({ searchTracks }));
    const { GET } = await import('@/app/api/search/route');
    const body = await (await GET(new Request('http://x/api/search?q=ab'))).json();
    expect(body.tracks).toEqual([]);
    expect(searchTracks).not.toHaveBeenCalled();
    await GET(new Request('http://x/api/search?q=abc'));
    expect(searchTracks).toHaveBeenCalledWith('abc');
    vi.doUnmock('@/lib/resolver');
  });
});

describe('M1: trackKeyOf strips same-recording qualifiers only', () => {
  it('maps length/mastering variants onto the plain key and keeps named remixes distinct', () => {
    const plain = trackKeyOf('CamelPhat', 'Cola');
    for (const t of ['Cola (Extended)', 'Cola (Extended Version)', 'Cola (Club Mix)', 'Cola (Edit)', 'Cola (Radio Edit)', 'Cola [2014 Remaster]', 'Cola - Extended Mix', 'Cola - Radio Version', 'Cola (Original Mix)'])
      expect(trackKeyOf('CamelPhat', t)).toBe(plain);
    expect(trackKeyOf('CamelPhat', 'Cola (Mark Knight Remix)')).not.toBe(plain);
    expect(trackKeyOf('CamelPhat', 'Cola - ARTBAT Remix')).not.toBe(plain);
    expect(trackKeyOf('CamelPhat', 'Cola (Dub Mix)')).not.toBe(plain);
    expect(trackKeyOf('Hozier', 'Delilah (pull me out of this)')).not.toBe(trackKeyOf('Hozier', 'Delilah'));
  });
});

describe('M2: sanitizeTrack keeps search fields', () => {
  it('keeps a valid version, duration and Spotify link and drops invalid ones', () => {
    const ok = sanitizeTrack({ id: 'x', artist: 'A', title: 'T', version: 'Extended Mix', durationMs: 401_000, spotifyUrl: 'https://open.spotify.com/track/abc' });
    expect(ok).toMatchObject({ version: 'Extended Mix', durationMs: 401_000, spotifyUrl: 'https://open.spotify.com/track/abc' });
    const bad = sanitizeTrack({ id: 'x', artist: 'A', title: 'T', version: 'x'.repeat(101), durationMs: 4_000_000, spotifyUrl: 'https://evil.example/track' });
    expect(bad).not.toHaveProperty('version');
    expect(bad).not.toHaveProperty('durationMs');
    expect(bad).not.toHaveProperty('spotifyUrl');
    expect(sanitizeTrack({ id: 'x', artist: 'A', title: 'T', durationMs: 0 })).not.toHaveProperty('durationMs');
  });
});

describe('M3: stable ids and recording-level "already in set"', () => {
  const hit = (over: Partial<MergedHit>): MergedHit => ({
    key: 'camelphat|cola|original|||d220',
    artist: 'CamelPhat',
    baseTitle: 'Cola',
    version: { baseTitle: 'Cola', kind: 'original', featuring: [] },
    providers: ['deezer'],
    score: 1,
    ...over,
  });

  it('the same recording gets the same id across searches, whatever the collision suffix or provider order', async () => {
    const { trackIdOf } = await import('@/lib/resolver');
    expect(trackIdOf(hit({ key: 'camelphat|cola|original|||d220#2' }))).toBe(trackIdOf(hit({})));
    expect(trackIdOf(hit({ isrc: 'GB1' }))).toBe('isrc-GB1');
    const { mergedSearch } = await import('@/lib/search/merge');
    const r14 = (order: 'sd' | 'ds') => {
      const s = prov('spotify', [res('spotify', 'CamelPhat', 'Cola', { isrc: 'GBZZZ', durationMs: 200_000 })]);
      const d = prov('deezer', [res('deezer', 'CamelPhat', 'Cola', { isrc: 'GBAAA', durationMs: 200_500 })]);
      return mergedSearch('camelphat cola', { providers: order === 'sd' ? [s, d] : [d, s] });
    };
    expect((await r14('sd')).hits[0].isrc).toBe('GBAAA');
    expect((await r14('ds')).hits[0].isrc).toBe('GBAAA');
  });

  it('adding the same recording twice is blocked even when the ids differ', () => {
    const a: Track = { id: 'search-a', artist: 'CamelPhat', title: 'Cola (Extended Mix)', version: 'Extended Mix', sources: {} };
    const sameIsrcX: Track = { id: 'isrc-GB1', artist: 'X', title: 'Y', isrc: 'GB1', sources: {} };
    const sameIsrcY: Track = { id: 'search-z', artist: 'Other', title: 'Other', isrc: 'gb1', sources: {} };
    let s = playlistReducer({ tracks: [], arc: { minutes: 60, shape: 'build' }, playFraction: 0.75 }, { type: 'add', track: a });
    s = playlistReducer(s, { type: 'add', track: { ...a, id: 'search-b' } });
    expect(s.tracks).toHaveLength(1);
    // a different version of the same work is a different recording
    s = playlistReducer(s, { type: 'add', track: { ...a, id: 'search-c', title: 'Cola (Mark Knight Remix)', version: 'Mark Knight Remix' } });
    s = playlistReducer(s, { type: 'add', track: { ...a, id: 'search-d', title: 'Cola', version: undefined } });
    expect(s.tracks).toHaveLength(3);
    s = playlistReducer(s, { type: 'add', track: sameIsrcX });
    s = playlistReducer(s, { type: 'add', track: sameIsrcY });
    expect(s.tracks).toHaveLength(4);
    expect(recordingKeys(sameIsrcY)).toContain('isrc:GB1');
  });
});
