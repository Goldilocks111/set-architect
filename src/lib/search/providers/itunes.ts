import { fetchJson } from '@/lib/http';
import { parseVersion } from '@/lib/search/version';
import type { SearchProvider, SearchResult } from '@/lib/search/types';

const SEARCH_URL = 'https://itunes.apple.com/search';

interface ItunesItem {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  trackTimeMillis?: number;
  releaseDate?: string;
  previewUrl?: string;
  artworkUrl100?: string;
  trackExplicitness?: string;
}

export function mapItunesItem(r: ItunesItem): SearchResult {
  const title = r.trackName ?? '';
  const artist = r.artistName ?? '';
  const artists = artist ? [artist] : [];
  const out: SearchResult = {
    provider: 'itunes',
    providerId: String(r.trackId ?? ''),
    artist,
    artists,
    title,
    version: parseVersion(title, artists),
  };
  if (typeof r.trackTimeMillis === 'number') out.durationMs = r.trackTimeMillis;
  if (r.releaseDate) out.releaseDate = r.releaseDate.slice(0, 10);
  if (r.previewUrl) out.previewUrl = r.previewUrl;
  if (r.artworkUrl100) out.artworkUrl = r.artworkUrl100.replace('100x100', '600x600');
  if (r.trackExplicitness) out.explicit = r.trackExplicitness === 'explicit';
  return out;
}

export const itunesSearchProvider: SearchProvider = {
  name: 'itunes',
  configured: () => true,
  async search(query, opts) {
    const limit = opts?.limit ?? 25;
    const data = await fetchJson<{ results?: ItunesItem[] }>(
      `${SEARCH_URL}?media=music&entity=song&limit=${limit}&term=${encodeURIComponent(query)}`
    );
    return (data.results ?? []).filter((r) => r.trackId !== undefined).map(mapItunesItem);
  },
};
