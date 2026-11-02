import { afterEach, describe, expect, it, vi } from 'vitest';
import { deezerAdapter, deezerSearch } from '@/lib/sources/deezer';
import { base, json, mockFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const hit = {
  id: 42,
  title: 'One More Time',
  rank: 850000,
  preview: 'https://cdn/p.mp3',
  bpm: 0,
  artist: { name: 'Daft Punk' },
  album: { cover_big: 'https://cdn/c.jpg' },
};

describe('deezer', () => {
  it('maps duration (seconds) to durationMs', async () => {
    mockFetch([
      ['/track/42', () => json({ ...hit, duration: 380 })],
      ['/search', () => json({ data: [{ ...hit, duration: 380 }] })],
    ]);
    expect((await deezerAdapter.enrich(base())).durationMs).toBe(380000);
    mockFetch([['/search', () => json({ data: [{ ...hit, duration: 380 }] })]]);
    expect((await deezerSearch('q'))[0].durationMs).toBe(380000);
  });
  it('ignores a zero/absent duration and a rejected (wrong-artist) hit', async () => {
    mockFetch([['/track/42', () => json({ ...hit, duration: 0 })], ['/search', () => json({ data: [{ ...hit, duration: 0 }] })]]);
    expect(await deezerAdapter.enrich(base())).not.toHaveProperty('durationMs');
    mockFetch([['/search', () => json({ data: [{ ...hit, duration: 200, artist: { name: 'Someone Else' } }] })]]);
    expect(await deezerAdapter.enrich(base())).toEqual({});
  });
  it('maps rank/preview/isrc/year and never bpm', async () => {
    mockFetch([
      ['/track/42', () => json({ ...hit, isrc: 'GBDUW0000059', release_date: '2001-03-12' })],
      ['/search', () => json({ data: [hit] })],
    ]);
    const out = await deezerAdapter.enrich(base());
    expect(out).toMatchObject({
      popularity: 85,
      previewUrl: 'https://cdn/p.mp3',
      isrc: 'GBDUW0000059',
      year: 2001,
      artworkUrl: 'https://cdn/c.jpg',
    });
    expect(out).not.toHaveProperty('bpm');
  });
  it('still returns search data when the detail call fails', async () => {
    mockFetch([
      ['/track/42', () => json({}, 404)],
      ['/search', () => json({ data: [hit] })],
    ]);
    expect((await deezerAdapter.enrich(base())).previewUrl).toBe('https://cdn/p.mp3');
  });
  it('uses a plain query first and rejects hits by a different artist', async () => {
    const f = mockFetch([
      ['/search', () => json({ data: [{ ...hit, artist: { name: 'Totally Other' } }] })],
    ]);
    expect(await deezerAdapter.enrich(base())).toEqual({});
    expect(decodeURIComponent(String(f.mock.calls[0][0]))).toContain('q=Daft Punk One More Time');
  });
  it('falls back to the fielded query when the plain one has no match', async () => {
    let n = 0;
    mockFetch([
      ['/track/42', () => json({ ...hit, release_date: '2001-03-12' })],
      ['/search', () => (n++ === 0 ? json({ data: [] }) : json({ data: [hit] }))],
    ]);
    expect((await deezerAdapter.enrich(base())).popularity).toBe(85);
  });
  it('returns {} for no match and throws on HTTP error', async () => {
    mockFetch([['/search', () => json({ data: [] })]]);
    expect(await deezerAdapter.enrich(base())).toEqual({});
    mockFetch([['/search', () => json({}, 403)]]);
    await expect(deezerAdapter.enrich(base())).rejects.toThrow();
  });
  it('search returns tracks with provenance', async () => {
    mockFetch([['/search', () => json({ data: [hit] })]]);
    const [t] = await deezerSearch('daft');
    expect(t).toMatchObject({ id: 'deezer-42', artist: 'Daft Punk', popularity: 85 });
    expect(t.sources.previewUrl).toBe('deezer');
  });
  it('is always configured', () => expect(deezerAdapter.configured()).toBe(true));
  it('a hit by the right artist but a different song is rejected: its preview/isrc/popularity never reach the cache', async () => {
    mockFetch([['/search', () => json({ data: [{ ...hit, id: 7, title: 'Harder Better Faster Stronger', preview: 'https://cdn/wrong.mp3' }] })]]);
    expect(await deezerAdapter.enrich(base())).toEqual({});
  });
  it('picks the right song when the wrong one ranks first; (Original Mix) and (feat. X) variants still match', async () => {
    mockFetch([
      ['/track/', () => json({}, 404)],
      ['/search', () => json({ data: [{ ...hit, id: 7, title: 'Aerodynamic', preview: 'wrong' }, { ...hit, title: 'One More Time (Original Mix)' }] })],
    ]);
    expect((await deezerAdapter.enrich(base())).previewUrl).toBe('https://cdn/p.mp3');
    mockFetch([['/track/', () => json({}, 404)], ['/search', () => json({ data: [{ ...hit, title: 'One More Time (feat. Romanthony)' }] })]]);
    expect((await deezerAdapter.enrich(base())).previewUrl).toBe('https://cdn/p.mp3');
  });
});
