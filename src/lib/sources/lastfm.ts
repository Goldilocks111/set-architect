import { fetchJson } from '../http';

export type SimilarItem = { artist: string; title: string; match: number };

export const lastfmConfigured = () => !!process.env.LASTFM_API_KEY;

export async function lastfmSimilar(artist: string, title: string): Promise<SimilarItem[]> {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return [];
  const data = await fetchJson<{
    similartracks?: { track?: Array<{ name: string; match: number | string; artist?: { name: string } }> };
  }>(
    `https://ws.audioscrobbler.com/2.0/?method=track.getsimilar&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(
      title
    )}&api_key=${encodeURIComponent(key)}&format=json&limit=30`
  );
  return (data.similartracks?.track ?? [])
    .map((t) => ({ artist: t.artist?.name ?? '', title: t.name, match: Number(t.match) }))
    .filter((t) => t.artist && t.title && Number.isFinite(t.match));
}
