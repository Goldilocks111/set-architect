import { afterEach, describe, expect, it, vi } from 'vitest';
import { reccobeatsAdapter } from '@/lib/sources/reccobeats';
import { base, json, mockFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('reccobeats', () => {
  it('maps audio features fetched by spotifyId', async () => {
    const f = mockFetch([
      ['/v1/audio-features?ids=SP1', () => json({ content: [{ tempo: 128, key: 0, mode: 1, energy: 1, danceability: 0.9 }] })],
    ]);
    expect(await reccobeatsAdapter.enrich(base({ spotifyId: 'SP1' }))).toEqual({
      bpm: 128,
      camelot: '8B',
      energy: 10,
      danceability: 0.9,
    });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('no spotifyId → {} without fetching', async () => {
    const f = mockFetch([]);
    expect(await reccobeatsAdapter.enrich(base())).toEqual({});
    expect(f).not.toHaveBeenCalled();
  });
  it('empty content → {}', async () => {
    mockFetch([['/v1/audio-features', () => json({ content: [] })]]);
    expect(await reccobeatsAdapter.enrich(base({ spotifyId: 'SP1' }))).toEqual({});
  });
  it('service down → throws (resolver skips it)', async () => {
    mockFetch([['reccobeats', () => new Response('error code: 1033', { status: 530 })]]);
    await expect(reccobeatsAdapter.enrich(base({ spotifyId: 'SP1' }))).rejects.toThrow();
  });
});
