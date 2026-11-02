import { fetchJson, HttpError } from '../http';
import { laneOfTag } from '../style/taxonomy';

export type Tag = { name: string; count: number };

/** Last.fm answers errors with HTTP 200 and { error, message }; 6 is "not found", 29 "rate limit exceeded". */
class LastfmError extends Error {
  constructor(public code: number, message: string) {
    super(`Last.fm error ${code}: ${message}`);
  }
}

/** Thrown when the caller's budget refuses a request: nothing was sent, nothing failed. */
export class LastfmBudgetError extends Error {
  constructor() {
    super('lastfm budget spent');
  }
}

const KEY_ERRORS = new Set([4, 9, 10, 26]); // invalid key / session / suspended: retrying never helps
let disabled = false;
export const lastfmTagsDisabled = () => disabled;

// Last.fm allows 5 req/s per IP: requests leave at least `paceMs` apart, process-wide.
let paceMs = 250;
let nextSlot = 0;
export function configureLastfmPacing(ms: number): void {
  paceMs = ms;
  nextSlot = 0;
}
export function resetLastfmTags(): void {
  disabled = false;
  nextSlot = 0;
}
async function pace(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + paceMs;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function topTags(method: string, params: Record<string, string>, key: string, take?: () => boolean): Promise<Tag[]> {
  if (take && !take()) throw new LastfmBudgetError();
  await pace();
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const data = await fetchJson<{ toptags?: { tag?: Array<{ name: string; count: number | string }> }; error?: number; message?: string }>(
    `https://ws.audioscrobbler.com/2.0/?method=${method}&${qs}&api_key=${encodeURIComponent(key)}&format=json`
  );
  if (data.error !== undefined) {
    const code = Number(data.error);
    if (code === 6) return []; // unknown track/artist: a real answer, not a failure
    if (code === 29) throw new HttpError(429, 'ws.audioscrobbler.com (rate limit exceeded)'); // opens the breaker
    if (KEY_ERRORS.has(code) && !disabled) {
      disabled = true;
      console.warn(`Last.fm key error ${code}: ${data.message ?? ''}. Style tags are off until restart.`);
    }
    throw new LastfmError(code, data.message ?? 'unknown');
  }
  return (data.toptags?.tag ?? [])
    .map((t) => ({ name: t.name, count: Number(t.count) }))
    .filter((t) => t.name && Number.isFinite(t.count));
}

const genreTags = (tags: Tag[]) => tags.filter((t) => laneOfTag(t.name)).length;

/**
 * Track tags; when fewer than 2 are genres, the artist's tags are added with their weights halved. `take` is called
 * once before each HTTP request (false → LastfmBudgetError).
 */
export async function lastfmTopTags(artist: string, title: string, opts: { take?: () => boolean } = {}): Promise<Tag[]> {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return [];
  if (disabled) throw new LastfmError(0, 'disabled after a key error');
  const tags = await topTags('track.gettoptags', { artist, track: title }, key, opts.take);
  if (genreTags(tags) >= 2) return tags;
  const artistTags = await topTags('artist.gettoptags', { artist }, key, opts.take);
  return [...tags, ...artistTags.map((t) => ({ name: t.name, count: t.count / 2 }))];
}
