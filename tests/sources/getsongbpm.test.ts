import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSongBpmAdapter } from '@/lib/sources/getsongbpm';
import { base, json, mockFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('getsongbpm', () => {
  it('is unconfigured without a key and does not fetch', async () => {
    vi.stubEnv('GETSONGBPM_API_KEY', '');
    const f = mockFetch([]);
    expect(getSongBpmAdapter.configured()).toBe(false);
    expect(await getSongBpmAdapter.enrich(base())).toEqual({});
    expect(f).not.toHaveBeenCalled();
  });
  it('maps tempo and key name to bpm/camelot', async () => {
    vi.stubEnv('GETSONGBPM_API_KEY', 'k');
    const f = mockFetch([['api.getsong.co', () => json({ search: [{ tempo: '123', key_of: 'F♯m' }] })]]);
    expect(getSongBpmAdapter.configured()).toBe(true);
    expect(await getSongBpmAdapter.enrich(base())).toEqual({ bpm: 123, camelot: '11A' });
    expect(String(f.mock.calls[0][0])).toContain('api_key=k');
  });
  it('no-match payload ({search:{error}}) → {}; HTTP error → throws', async () => {
    vi.stubEnv('GETSONGBPM_API_KEY', 'k');
    mockFetch([['api.getsong.co', () => json({ search: { error: 'no result' } })]]);
    expect(await getSongBpmAdapter.enrich(base())).toEqual({});
    mockFetch([['api.getsong.co', () => json({}, 401)]]);
    await expect(getSongBpmAdapter.enrich(base())).rejects.toThrow();
  });
});
