import { afterEach, describe, expect, it, vi } from 'vitest';
import { itunesAdapter, itunesSearch } from '@/lib/sources/itunes';
import { base, json, mockFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const r = {
  trackId: 7,
  trackName: 'One More Time',
  artistName: 'Daft Punk',
  previewUrl: 'https://aac/p.m4a',
  trackViewUrl: 'https://music.apple.com/x',
  artworkUrl100: 'https://img/100x100bb.jpg',
  releaseDate: '2001-03-13T08:00:00Z',
};

describe('itunes', () => {
  it('maps previewUrl and itunesUrl', async () => {
    mockFetch([['itunes.apple.com', () => json({ results: [r] })]]);
    const out = await itunesAdapter.enrich(base());
    expect(out).toMatchObject({ previewUrl: r.previewUrl, itunesUrl: r.trackViewUrl, year: 2001 });
    expect(out.artworkUrl).toContain('600x600');
  });
  it('prefers the result whose artist matches', async () => {
    mockFetch([
      ['itunes.apple.com', () => json({ results: [{ ...r, artistName: 'Cover Band', previewUrl: 'x' }, r] })],
    ]);
    expect((await itunesAdapter.enrich(base())).previewUrl).toBe(r.previewUrl);
  });
  it('rejects results by an unrelated artist (no wrong-track preview)', async () => {
    mockFetch([['itunes.apple.com', () => json({ results: [{ ...r, artistName: 'Cover Band' }] })]]);
    expect(await itunesAdapter.enrich(base())).toEqual({});
  });
  it('empty results → {}; HTTP error → throws', async () => {
    mockFetch([['itunes.apple.com', () => json({ results: [] })]]);
    expect(await itunesAdapter.enrich(base())).toEqual({});
    mockFetch([['itunes.apple.com', () => json({}, 400)]]);
    await expect(itunesAdapter.enrich(base())).rejects.toThrow();
  });
  it('search maps to tracks', async () => {
    mockFetch([['itunes.apple.com', () => json({ results: [r] })]]);
    expect((await itunesSearch('daft'))[0]).toMatchObject({ id: 'itunes-7', title: 'One More Time' });
  });
});
