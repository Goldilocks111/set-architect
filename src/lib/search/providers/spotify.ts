import { fetchJson } from '@/lib/http';
import { getToken, spotifyAdapter } from '@/lib/sources/spotify';
import { parseVersion } from '@/lib/search/version';
import type { SearchProvider, SearchResult } from '@/lib/search/types';

const SEARCH_URL = 'https://api.spotify.com/v1/search';
// Dev-mode apps are capped at 10 results per request.
const MAX_LIMIT = 10;
const MAX_ARTWORK_WIDTH = 640;

interface SpotifyImage {
  url: string;
  width?: number | null;
}

interface SpotifyItem {
  id: string;
  name: string;
  duration_ms?: number;
  explicit?: boolean;
  popularity?: number;
  external_urls?: { spotify?: string };
  external_ids?: { isrc?: string };
  artists?: Array<{ name: string }>;
  album?: { release_date?: string; images?: SpotifyImage[] };
}

function pickArtwork(images: SpotifyImage[] = []): string | undefined {
  const fitting = images.filter((i) => (i.width ?? 0) <= MAX_ARTWORK_WIDTH);
  const pool = fitting.length ? fitting : images;
  return pool.reduce<SpotifyImage | undefined>(
    (best, i) => (!best || (i.width ?? 0) > (best.width ?? 0) ? i : best),
    undefined
  )?.url;
}

export function mapSpotifyItem(t: SpotifyItem): SearchResult {
  const artists = (t.artists ?? []).map((a) => a.name);
  const out: SearchResult = {
    provider: 'spotify',
    providerId: t.id,
    artist: artists.join(', '),
    artists,
    title: t.name,
    version: parseVersion(t.name, artists),
    spotifyId: t.id,
  };
  if (t.external_urls?.spotify) out.spotifyUrl = t.external_urls.spotify;
  if (t.external_ids?.isrc) out.isrc = t.external_ids.isrc;
  if (typeof t.duration_ms === 'number') out.durationMs = t.duration_ms;
  if (t.album?.release_date) out.releaseDate = t.album.release_date;
  if (typeof t.popularity === 'number') out.popularity = t.popularity;
  const art = pickArtwork(t.album?.images);
  if (art) out.artworkUrl = art;
  if (typeof t.explicit === 'boolean') out.explicit = t.explicit;
  return out;
}

export const spotifySearchProvider: SearchProvider = {
  name: 'spotify',
  configured: () => spotifyAdapter.configured(),
  async search(query, opts) {
    const limit = Math.max(1, Math.min(opts?.limit ?? MAX_LIMIT, MAX_LIMIT));
    const token = await getToken();
    const data = await fetchJson<{ tracks?: { items?: SpotifyItem[] } }>(
      `${SEARCH_URL}?type=track&limit=${limit}&q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return (data.tracks?.items ?? []).map(mapSpotifyItem);
  },
};
