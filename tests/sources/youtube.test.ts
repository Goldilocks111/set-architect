import { afterEach, describe, expect, it, vi } from 'vitest';
import { youtubeAdapter, youtubeSearchUrl } from '@/lib/sources/youtube';
import { base, json, mockFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('youtube', () => {
  it('without a key builds a search URL and makes no request', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', '');
    const f = mockFetch([]);
    const out = await youtubeAdapter.enrich(base());
    expect(out.youtubeUrl).toBe(youtubeSearchUrl('Daft Punk', 'One More Time'));
    expect(out.youtubeUrl).toContain('youtube.com/results?search_query=');
    expect(f).not.toHaveBeenCalled();
  });
  it('with a key returns a direct watch link', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', 'yk');
    mockFetch([['googleapis.com/youtube', () => json({ items: [{ id: { videoId: 'abc' } }] })]]);
    expect((await youtubeAdapter.enrich(base())).youtubeUrl).toBe('https://www.youtube.com/watch?v=abc');
  });
  it('with a key but API error → falls back to the search URL', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', 'yk');
    mockFetch([['googleapis.com/youtube', () => json({}, 403)]]);
    expect((await youtubeAdapter.enrich(base())).youtubeUrl).toBe(youtubeSearchUrl('Daft Punk', 'One More Time'));
  });
});
