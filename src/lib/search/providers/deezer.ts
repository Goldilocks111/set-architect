import { fetchJson } from '@/lib/http';
import { parseVersion } from '@/lib/search/version';
import type { SearchProvider, SearchResult } from '@/lib/search/types';

const BASE = 'https://api.deezer.com';

interface DeezerItem {
  id: number;
  title: string;
  title_version?: string;
  isrc?: string;
  duration?: number;
  rank?: number;
  explicit_lyrics?: boolean;
  preview?: string;
  artist?: { name: string };
  album?: { cover_big?: string; cover_medium?: string };
}

/** Deezer rank is an unbounded play-based number (~1e6 for big hits): log-scale it so 1e6 maps to 100. */
export function popularityFromRank(rank?: number): number | undefined {
  if (typeof rank !== 'number' || rank <= 0) return undefined;
  return Math.min(100, Math.round((Math.log10(1 + rank) / 6) * 100));
}

export function mapDeezerItem(t: DeezerItem): SearchResult {
  const artist = t.artist?.name ?? '';
  const artists = artist ? [artist] : [];
  // Deezer often splits the qualifier into title_version ("Extended Mix") instead of title.
  const parseInput =
    t.title_version && !t.title.includes(t.title_version) ? `${t.title} ${t.title_version}` : t.title;
  const out: SearchResult = {
    provider: 'deezer',
    providerId: String(t.id),
    artist,
    artists,
    title: t.title,
    version: parseVersion(parseInput, artists),
  };
  if (t.isrc) out.isrc = t.isrc;
  if (typeof t.duration === 'number') out.durationMs = t.duration * 1000;
  const pop = popularityFromRank(t.rank);
  if (pop !== undefined) out.popularity = pop;
  const art = t.album?.cover_big ?? t.album?.cover_medium;
  if (art) out.artworkUrl = art;
  if (t.preview) out.previewUrl = t.preview;
  if (typeof t.explicit_lyrics === 'boolean') out.explicit = t.explicit_lyrics;
  return out;
}

export const deezerSearchProvider: SearchProvider = {
  name: 'deezer',
  configured: () => true,
  async search(query, opts) {
    const limit = opts?.limit ?? 25;
    const data = await fetchJson<{ data?: DeezerItem[] }>(
      `${BASE}/search?q=${encodeURIComponent(query)}&limit=${limit}`
    );
    return (data.data ?? []).map(mapDeezerItem);
  },
};
