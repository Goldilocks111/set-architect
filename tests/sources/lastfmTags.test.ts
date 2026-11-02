import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastfmTopTags } from '@/lib/sources/lastfmTags';
import { json, mockFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const tags = (...t: Array<[string, number]>) => json({ toptags: { tag: t.map(([name, count]) => ({ name, count })) } });

describe('lastfmTopTags', () => {
  it('returns track tags when there are enough genre tags', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    const f = mockFetch([['track.gettoptags', () => tags(['techno', 100], ['melodic techno', 60], ['seen live', 20])]]);
    expect(await lastfmTopTags('A', 'T')).toEqual([
      { name: 'techno', count: 100 },
      { name: 'melodic techno', count: 60 },
      { name: 'seen live', count: 20 },
    ]);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('falls back to artist tags with halved weights when < 2 genre tags', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([
      ['track.gettoptags', () => tags(['techno', 100], ['seen live', 50])],
      ['artist.gettoptags', () => tags(['deep house', 80])],
    ]);
    expect(await lastfmTopTags('A', 'T')).toEqual([
      { name: 'techno', count: 100 },
      { name: 'seen live', count: 50 },
      { name: 'deep house', count: 40 },
    ]);
  });
  it('empty when no key (no fetch)', async () => {
    vi.stubEnv('LASTFM_API_KEY', '');
    const f = mockFetch([]);
    expect(await lastfmTopTags('A', 'T')).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
  it('empty when both lookups return no tags', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['gettoptags', () => json({ toptags: { tag: [] } })]]);
    expect(await lastfmTopTags('A', 'T')).toEqual([]);
  });
  it('HTTP error throws', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['gettoptags', () => json({}, 500)]]);
    await expect(lastfmTopTags('A', 'T')).rejects.toThrow();
  });
  it('Last.fm error body (HTTP 200) throws', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['gettoptags', () => json({ error: 29, message: 'Rate limit exceeded' })]]);
    await expect(lastfmTopTags('A', 'T')).rejects.toThrow(/Rate limit/);
  });
  it('track-not-found error (code 6) falls back to artist tags', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([
      ['track.gettoptags', () => json({ error: 6, message: 'Track not found' })],
      ['artist.gettoptags', () => tags(['techno', 90], ['hard techno', 10])],
    ]);
    expect(await lastfmTopTags('A', 'T')).toEqual([
      { name: 'techno', count: 45 },
      { name: 'hard techno', count: 5 },
    ]);
  });
});
