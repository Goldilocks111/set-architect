import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLastfmPacing, lastfmTagsDisabled, lastfmTopTags, resetLastfmTags } from '@/lib/sources/lastfmTags';
import { HttpError } from '@/lib/http';
import { json, mockFetch } from './helpers';

beforeEach(() => {
  resetLastfmTags();
  configureLastfmPacing(0);
});
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
  it('rate-limit body (code 29) becomes an HttpError 429 so the breaker opens', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['gettoptags', () => json({ error: 29, message: 'Rate limit exceeded' })]]);
    const err = await lastfmTopTags('A', 'T').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
  });
  it('key errors (10, 26) disable Last.fm tags for the process and are logged once', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = mockFetch([['gettoptags', () => json({ error: 10, message: 'Invalid API key' })]]);
    await expect(lastfmTopTags('A', 'T')).rejects.toThrow();
    expect(lastfmTagsDisabled()).toBe(true);
    await expect(lastfmTopTags('A', 'T')).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
  it('artist not found (error 6) is an empty result, not a failure', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['gettoptags', () => json({ error: 6, message: 'not found' })]]);
    expect(await lastfmTopTags('A', 'T')).toEqual([]);
  });
  it('takes one budget unit per HTTP call and stops quietly when refused', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    const take = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const f = mockFetch([['track.gettoptags', () => tags(['seen live', 5])], ['artist.gettoptags', () => tags(['techno', 5])]]);
    await expect(lastfmTopTags('A', 'T', { take })).rejects.toThrow(/budget/);
    expect(take).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('paces calls process-wide', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    configureLastfmPacing(60);
    vi.useFakeTimers(); // virtual clock: no dependence on real timer jitter under a loaded machine
    try {
      const at: number[] = [];
      mockFetch([['gettoptags', () => { at.push(Date.now()); return tags(['techno', 5], ['house', 4]); }]]);
      const all = Promise.all([lastfmTopTags('A', 'T'), lastfmTopTags('B', 'U'), lastfmTopTags('C', 'V')]);
      await vi.advanceTimersByTimeAsync(500);
      await all;
      expect(at).toHaveLength(3);
      expect(at[1] - at[0]).toBeGreaterThanOrEqual(60);
      expect(at[2] - at[1]).toBeGreaterThanOrEqual(60);
    } finally {
      vi.useRealTimers();
    }
  });
  it('an already-aborted lookup sends no request', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    const f = mockFetch([['gettoptags', () => tags(['techno', 5])]]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(lastfmTopTags('A', 'T', { signal: ctrl.signal })).rejects.toThrow(/skipped/);
    expect(f).not.toHaveBeenCalled();
  });
  it('aborting while waiting for a pacing slot never fires the request afterwards', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    configureLastfmPacing(150);
    const f = mockFetch([['gettoptags', () => tags(['techno', 5], ['house', 4])]]);
    await lastfmTopTags('A', 'T'); // takes the first slot
    const ctrl = new AbortController();
    const p = lastfmTopTags('B', 'U', { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 30);
    await expect(p).rejects.toThrow(/skipped/);
    await new Promise((r) => setTimeout(r, 200));
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('mood tags do not count toward the 2-genre threshold', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    const f = mockFetch([
      ['track.gettoptags', () => tags(['techno', 100], ['chill', 50], ['ambient', 40])],
      ['artist.gettoptags', () => tags(['melodic techno', 80])],
    ]);
    await lastfmTopTags('A', 'T');
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('Last.fm error body (HTTP 200) throws', async () => {
    vi.stubEnv('LASTFM_API_KEY', 'k');
    mockFetch([['gettoptags', () => json({ error: 8, message: 'Operation failed' })]]);
    await expect(lastfmTopTags('A', 'T')).rejects.toThrow(/Operation failed/);
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
