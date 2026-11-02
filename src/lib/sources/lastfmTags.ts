import { fetchJson, HttpError } from '../http';
import { laneOfTag } from '../style/taxonomy';

export type Tag = { name: string; count: number };

/** Last.fm answers errors with HTTP 200 and { error, message }; 6 is "not found", 29 "rate limit exceeded". */
class LastfmError extends Error {
  constructor(public code: number, message: string) {
    super(`Last.fm error ${code}: ${message}`);
  }
}

/** Thrown when the caller's budget refuses a request or the caller aborted: nothing was sent, nothing failed. */
export class LastfmSkippedError extends Error {
  constructor(why: 'budget' | 'aborted') {
    super(`lastfm lookup skipped: ${why}`);
  }
}

/** Per HTTP call, counted from the moment the request is sent (waiting for a pacing slot is not part of it). */
export const LASTFM_TIMEOUT_MS = 4000;

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
async function pace(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + paceMs;
  if (at > now)
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, at - now);
      signal?.addEventListener('abort', done, { once: true });
    });
}

/**
 * One paced Last.fm API call, shared by every Last.fm lookup (tags, similar tracks). `take` is asked once before the
 * request (false → LastfmSkippedError). Error bodies (HTTP 200): 6 "not found" → undefined, 29 → HttpError 429 (opens
 * the breaker), key errors switch Last.fm off for the process.
 */
export async function lastfmGet<T>(
  method: string,
  params: Record<string, string>,
  opts: { take?: () => boolean; signal?: AbortSignal } = {}
): Promise<T | undefined> {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return undefined;
  if (disabled) throw new LastfmError(0, 'disabled after a key error');
  const { take, signal } = opts;
  if (signal?.aborted) throw new LastfmSkippedError('aborted');
  if (take && !take()) throw new LastfmSkippedError('budget');
  await pace(signal);
  if (signal?.aborted) throw new LastfmSkippedError('aborted'); // never fire a request the caller gave up on
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const data = await fetchJson<T & { error?: number; message?: string }>(
    `https://ws.audioscrobbler.com/2.0/?method=${method}&${qs}&api_key=${encodeURIComponent(key)}&format=json`,
    { timeoutMs: LASTFM_TIMEOUT_MS, retries: 0, signal }
  );
  if (data.error !== undefined) {
    const code = Number(data.error);
    if (code === 6) return undefined; // unknown track/artist: a real answer, not a failure
    if (code === 29) throw new HttpError(429, 'ws.audioscrobbler.com (rate limit exceeded)'); // opens the breaker
    if (KEY_ERRORS.has(code) && !disabled) {
      disabled = true;
      console.warn(`Last.fm key error ${code}: ${data.message ?? ''}. Last.fm lookups are off until restart.`);
    }
    throw new LastfmError(code, data.message ?? 'unknown');
  }
  return data;
}

async function topTags(method: string, params: Record<string, string>, take?: () => boolean, signal?: AbortSignal): Promise<Tag[]> {
  const data = await lastfmGet<{ toptags?: { tag?: Array<{ name: string; count: number | string }> } }>(method, params, { take, signal });
  return (data?.toptags?.tag ?? [])
    .map((t) => ({ name: t.name, count: Number(t.count) }))
    .filter((t) => t.name && Number.isFinite(t.count));
}

const genreTags = (tags: Tag[]) => tags.filter((t) => laneOfTag(t.name)).length;

/**
 * Track tags; when fewer than 2 are genres, the artist's tags are added with their weights halved. `take` is called
 * once before each HTTP request (false → LastfmSkippedError); `signal` cancels the lookup.
 */
export async function lastfmTopTags(artist: string, title: string, opts: { take?: () => boolean; signal?: AbortSignal } = {}): Promise<Tag[]> {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return [];
  if (disabled) throw new LastfmError(0, 'disabled after a key error');
  const tags = await topTags('track.gettoptags', { artist, track: title }, opts.take, opts.signal);
  if (genreTags(tags) >= 2) return tags;
  const artistTags = await topTags('artist.gettoptags', { artist }, opts.take, opts.signal);
  return [...tags, ...artistTags.map((t) => ({ name: t.name, count: t.count / 2 }))];
}
