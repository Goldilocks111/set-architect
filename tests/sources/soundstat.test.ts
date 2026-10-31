import { afterEach, describe, expect, it, vi } from 'vitest';
import { soundstatAdapter } from '@/lib/sources/soundstat';
import { base, json, mockFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('soundstat', () => {
  it('unconfigured without key', async () => {
    vi.stubEnv('SOUNDSTAT_API_KEY', '');
    const f = mockFetch([]);
    expect(soundstatAdapter.configured()).toBe(false);
    expect(await soundstatAdapter.enrich(base({ spotifyId: 'abc' }))).toEqual({});
    expect(f).not.toHaveBeenCalled();
  });
  it('does nothing without a spotifyId', async () => {
    vi.stubEnv('SOUNDSTAT_API_KEY', 'sk');
    const f = mockFetch([]);
    expect(await soundstatAdapter.enrich(base())).toEqual({});
    expect(f).not.toHaveBeenCalled();
  });
  it('GET /track/{spotifyId} maps features and sends the key header', async () => {
    vi.stubEnv('SOUNDSTAT_API_KEY', 'sk');
    const f = mockFetch([
      ['soundstat.info/api/v1/track/SP123', () => json({ features: { tempo: 122.04, key: 9, mode: 0, energy: 0.5, danceability: 0.7 } })],
    ]);
    expect(await soundstatAdapter.enrich(base({ spotifyId: 'SP123' }))).toEqual({
      bpm: 122,
      camelot: '8A',
      energy: 6,
      danceability: 0.7,
    });
    expect(((f.mock.calls[0] as unknown[])[1] as RequestInit).headers).toMatchObject({ 'x-api-key': 'sk' });
  });
  it('null features (analysis pending) → {}', async () => {
    vi.stubEnv('SOUNDSTAT_API_KEY', 'sk');
    mockFetch([['soundstat.info', () => json({ status: 'processing', features: null })]]);
    expect(await soundstatAdapter.enrich(base({ spotifyId: 'SP123' }))).toEqual({});
  });
  it('HTTP error → throws', async () => {
    vi.stubEnv('SOUNDSTAT_API_KEY', 'sk');
    mockFetch([['soundstat.info', () => json({}, 402)]]);
    await expect(soundstatAdapter.enrich(base({ spotifyId: 'SP123' }))).rejects.toThrow();
  });
});
