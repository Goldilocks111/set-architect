import type { Track } from '@/types/track';
import { fetchJson } from '../http';
import type { SourceAdapter } from './types';

const BASE = 'https://musicbrainz.org/ws/2';
// MusicBrainz rejects anonymous clients: a descriptive User-Agent is mandatory.
export const MUSICBRAINZ_UA = 'SetArchitect/0.1 (github.com/Goldilocks111/set-architect)';
const MIN_SCORE = 90;

let minGapMs = 1100; // hard limit is 1 req/s; small margin
let nextSlot = 0;

/** Test hook: shrinks the spacing and clears the queue. */
export function configureMusicBrainzLimiter(gapMs: number): void {
  minGapMs = gapMs;
  nextSlot = 0;
}

/** Process-wide limiter: every MusicBrainz request waits for its own slot, at least minGapMs after the previous. */
async function slot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + minGapMs;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function mbGet<T>(path: string): Promise<T> {
  await slot();
  return fetchJson<T>(`${BASE}${path}`, {
    timeoutMs: 5000,
    retries: 0,
    headers: { 'User-Agent': MUSICBRAINZ_UA, Accept: 'application/json' },
  });
}

const escapeLucene = (s: string) => s.replace(/(["\\])/g, '\\$1');

async function byIsrc(isrc: string): Promise<string | undefined> {
  const res = await mbGet<{ recordings?: Array<{ id?: string }> }>(`/isrc/${encodeURIComponent(isrc)}?fmt=json`);
  return res.recordings?.find((r) => r.id)?.id;
}

async function bySearch(artist: string, title: string): Promise<string | undefined> {
  const q = `artist:"${escapeLucene(artist)}" AND recording:"${escapeLucene(title)}"`;
  const res = await mbGet<{ recordings?: Array<{ id?: string; score?: number }> }>(
    `/recording?fmt=json&limit=5&query=${encodeURIComponent(q)}`
  );
  return res.recordings?.find((r) => r.id && (r.score ?? 0) >= MIN_SCORE)?.id;
}

export const musicbrainzAdapter: SourceAdapter = {
  name: 'musicbrainz',
  timeoutMs: 6000,
  configured: () => true,
  async enrich(partial: Track) {
    if (partial.mbid) return {};
    let mbid: string | undefined;
    if (partial.isrc) {
      try {
        mbid = await byIsrc(partial.isrc);
      } catch {
        // unknown ISRC is a 404: fall through to text search
      }
    }
    if (!mbid) mbid = await bySearch(partial.artist, partial.title);
    return mbid ? { mbid } : {};
  },
};
