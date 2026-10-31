import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { musicbrainzSearchProvider, musicbrainzWorkQuery } from '@/lib/search/providers/musicbrainz';
import { configureMusicBrainzLimiter, MUSICBRAINZ_UA } from '@/lib/sources/musicbrainz';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  configureMusicBrainzLimiter(0);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  configureMusicBrainzLimiter(1100);
});

const rec = {
  id: 'mbid-1',
  title: 'Latch (Joel Fletcher remix)',
  length: 363000,
  isrcs: ['GBUM71304321'],
  'first-release-date': '2013-10-07',
  'artist-credit': [
    { name: 'Disclosure', joinphrase: ' feat. ' },
    { name: 'Sam Smith', joinphrase: '' },
  ],
};

describe('musicbrainzWorkQuery', () => {
  it('fetches every recording of the work and boosts the asked version words', () => {
    expect(musicbrainzWorkQuery('Latch', 'Disclosure', ['Extended', 'Version'])).toBe(
      '+recording:"Latch" +artist:"Disclosure" recording:(extended version)^10'
    );
    expect(musicbrainzWorkQuery('I Got U', 'Duke Dumont', ['W&W', 'Remix'])).toBe(
      '+recording:"I Got U" +artist:"Duke Dumont" recording:(w and w remix)^10'
    );
    expect(musicbrainzWorkQuery('Say "Hi"', 'A', [])).toBe('+recording:"Say \\"Hi\\"" +artist:"A"');
  });
});

describe('musicbrainz search provider', () => {
  it('maps recordings and sends the mandatory User-Agent', async () => {
    fetchMock.mockResolvedValueOnce(json({ recordings: [rec] }));
    const [r] = await musicbrainzSearchProvider.search('+recording:"Latch" +artist:"Disclosure"');
    expect(r).toMatchObject({
      provider: 'musicbrainz',
      providerId: 'mbid-1',
      artist: 'Disclosure, Sam Smith',
      artists: ['Disclosure', 'Sam Smith'],
      title: 'Latch (Joel Fletcher remix)',
      isrc: 'GBUM71304321',
      durationMs: 363000,
      releaseDate: '2013-10-07',
    });
    expect(r.version).toMatchObject({ baseTitle: 'Latch', kind: 'remix', remixer: 'Joel Fletcher' });
    expect(r.previewUrl).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('https://musicbrainz.org/ws/2/recording?fmt=json&limit=25&query=');
    expect(decodeURIComponent(url)).toContain('+recording:"Latch" +artist:"Disclosure"');
    expect(init.headers['User-Agent']).toBe(MUSICBRAINZ_UA);
  });

  it('returns [] for no recordings and throws on HTTP errors', async () => {
    fetchMock.mockResolvedValueOnce(json({ count: 0 }));
    expect(await musicbrainzSearchProvider.search('x')).toEqual([]);
    fetchMock.mockResolvedValueOnce(json({}, 503));
    await expect(musicbrainzSearchProvider.search('x')).rejects.toThrow(/503/);
  });

  it('shares the process-wide 1 req/s MusicBrainz limiter', async () => {
    configureMusicBrainzLimiter(1100);
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => json({ recordings: [] }));
    const a = musicbrainzSearchProvider.search('a');
    const b = musicbrainzSearchProvider.search('b');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
