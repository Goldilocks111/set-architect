import { lastfmGet } from './lastfmTags';

export type SimilarItem = { artist: string; title: string; match: number };

export const lastfmConfigured = () => !!process.env.LASTFM_API_KEY;

/** track.getSimilar through the shared Last.fm call: same pacing, error-body handling and `take` budget hook as tags. */
export async function lastfmSimilar(
  artist: string,
  title: string,
  opts: { take?: () => boolean; signal?: AbortSignal } = {}
): Promise<SimilarItem[]> {
  const data = await lastfmGet<{
    similartracks?: { track?: Array<{ name: string; match: number | string; artist?: { name: string } }> };
  }>('track.getsimilar', { artist, track: title, limit: '30' }, opts);
  return (data?.similartracks?.track ?? [])
    .map((t) => ({ artist: t.artist?.name ?? '', title: t.name, match: Number(t.match) }))
    .filter((t) => t.artist && t.title && Number.isFinite(t.match));
}
