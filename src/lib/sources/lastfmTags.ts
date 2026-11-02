import { fetchJson } from '../http';
import { laneOfTag } from '../style/taxonomy';

export type Tag = { name: string; count: number };

/** Last.fm answers errors with HTTP 200 and { error, message }; error 6 is "not found". */
class LastfmError extends Error {
  constructor(public code: number, message: string) {
    super(`Last.fm error ${code}: ${message}`);
  }
}

async function topTags(method: string, params: Record<string, string>, key: string): Promise<Tag[]> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const data = await fetchJson<{ toptags?: { tag?: Array<{ name: string; count: number | string }> }; error?: number; message?: string }>(
    `https://ws.audioscrobbler.com/2.0/?method=${method}&${qs}&api_key=${encodeURIComponent(key)}&format=json`
  );
  if (data.error !== undefined) throw new LastfmError(Number(data.error), data.message ?? 'unknown');
  return (data.toptags?.tag ?? [])
    .map((t) => ({ name: t.name, count: Number(t.count) }))
    .filter((t) => t.name && Number.isFinite(t.count));
}

const genreTags = (tags: Tag[]) => tags.filter((t) => laneOfTag(t.name)).length;

/** Track tags; when fewer than 2 are genres, the artist's tags are added with their weights halved. */
export async function lastfmTopTags(artist: string, title: string): Promise<Tag[]> {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return [];
  let tags: Tag[] = [];
  try {
    tags = await topTags('track.gettoptags', { artist, track: title }, key);
  } catch (err) {
    if (!(err instanceof LastfmError && err.code === 6)) throw err; // unknown track: the artist may still be tagged
  }
  if (genreTags(tags) >= 2) return tags;
  const artistTags = await topTags('artist.gettoptags', { artist }, key);
  return [...tags, ...artistTags.map((t) => ({ name: t.name, count: t.count / 2 }))];
}
