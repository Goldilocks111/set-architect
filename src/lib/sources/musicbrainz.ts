import type { Track } from '@/types/track';
import { fetchJson } from '../http';
import { titleMatches } from './match';
import { lengthAgrees } from '../duration';
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

/** How long a request made now would wait for its slot in the shared queue. */
export function musicBrainzQueueDelayMs(now = Date.now()): number {
  return Math.max(0, nextSlot - now);
}

/** Process-wide limiter: every MusicBrainz request waits for its own slot, at least minGapMs after the previous. */
async function slot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + minGapMs;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export async function mbGet<T>(path: string): Promise<T> {
  await slot();
  return fetchJson<T>(`${BASE}${path}`, {
    timeoutMs: 5000,
    retries: 0,
    headers: { 'User-Agent': MUSICBRAINZ_UA, Accept: 'application/json' },
  });
}

export const escapeLucene = (s: string) => s.replace(/(["\\])/g, '\\$1');

interface MbRecording {
  id?: string;
  title?: string;
  score?: number;
  length?: number;
}

/** The accepted recording's id, plus its length when the recording is the wanted song (not just a high-scoring neighbour). */
interface MbMatch {
  mbid: string;
  durationMs?: number;
}

function accept(r: MbRecording, wantedTitle: string, artist: string): MbMatch | undefined {
  if (!r.id) return undefined;
  const ok = typeof r.length === 'number' && r.length > 0 && (!r.title || (titleMatches(wantedTitle, r.title, artist) && lengthAgrees(wantedTitle, r.title)));
  return ok ? { mbid: r.id, durationMs: r.length } : { mbid: r.id };
}

async function byIsrc(isrc: string, partial: Track): Promise<MbMatch | undefined> {
  const res = await mbGet<{ recordings?: MbRecording[] }>(`/isrc/${encodeURIComponent(isrc)}?fmt=json`);
  const r = res.recordings?.find((x) => x.id);
  return r && accept(r, partial.title, partial.artist);
}

async function bySearch(artist: string, title: string): Promise<MbMatch | undefined> {
  const q = `artist:"${escapeLucene(artist)}" AND recording:"${escapeLucene(title)}"`;
  const res = await mbGet<{ recordings?: MbRecording[] }>(`/recording?fmt=json&limit=5&query=${encodeURIComponent(q)}`);
  const r = res.recordings?.find((x) => x.id && (x.score ?? 0) >= MIN_SCORE);
  return r && accept(r, title, artist);
}

export const musicbrainzAdapter: SourceAdapter = {
  name: 'musicbrainz',
  timeoutMs: 6000,
  configured: () => true,
  async enrich(partial: Track) {
    if (partial.mbid) return {};
    let found: MbMatch | undefined;
    if (partial.isrc) {
      try {
        found = await byIsrc(partial.isrc, partial);
      } catch {
        // unknown ISRC is a 404: fall through to text search
      }
    }
    if (!found) found = await bySearch(partial.artist, partial.title);
    if (!found) return {};
    return found.durationMs !== undefined ? { mbid: found.mbid, durationMs: found.durationMs } : { mbid: found.mbid };
  },
};
