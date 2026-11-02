import { isComplete } from '@/lib/completeness';
import { trackKeyOf, type Track } from '@/types/track';

/** The DJ's own candidate pool: everything they imported or added, kept in this browser. */
export const CRATE_KEY = 'setarch:crate:v1';
export const CRATE_MAX = 2000;
/** Most items one suggest request carries; the rest of a big crate waits its turn (complete, then recent, first). */
export const CRATE_SEND_MAX = 600;

export type CrateTrack = Pick<
  Track,
  'id' | 'artist' | 'title' | 'bpm' | 'camelot' | 'energy' | 'danceability' | 'version' | 'durationMs'
> & {
  /** Style tags; optional so the crate works before and after tags exist on Track. */
  styles?: string[];
  addedAt: number;
  from: 'set' | 'spotify' | 'mik' | 'search';
};

const keyOf = (t: { artist: string; title: string }) => trackKeyOf(t.artist, t.title);

/** Only what scoring needs: previews, links and provenance never go in the crate. */
function toCrateTrack(t: Track & { styles?: string[] }, from: CrateTrack['from'], addedAt: number): CrateTrack {
  const c: CrateTrack = { id: t.id, artist: t.artist, title: t.title, addedAt, from };
  for (const f of ['bpm', 'camelot', 'energy', 'danceability', 'version', 'durationMs', 'styles'] as const) {
    if (t[f] !== undefined) (c as Record<string, unknown>)[f] = t[f];
  }
  return c;
}

const isCrateTrack = (v: unknown): v is CrateTrack => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.artist === 'string' && typeof o.title === 'string' && typeof o.addedAt === 'number';
};

export function loadCrate(): CrateTrack[] {
  try {
    const raw = window.localStorage.getItem(CRATE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isCrateTrack).slice(-CRATE_MAX) : [];
  } catch {
    return [];
  }
}

function saveCrate(crate: CrateTrack[]): void {
  try {
    window.localStorage.setItem(CRATE_KEY, JSON.stringify(crate));
  } catch {
    // storage blocked or full: the crate still lives in memory for this session
  }
}

/** Dedupes by artist/title key (newest wins, but keeps fields the older copy knew), oldest dropped past CRATE_MAX. */
export function addToCrate(tracks: Track[], from: CrateTrack['from']): CrateTrack[] {
  const byKey = new Map(loadCrate().map((c) => [keyOf(c), c]));
  const now = Date.now();
  tracks.forEach((t, i) => {
    const k = keyOf(t);
    const old = byKey.get(k);
    byKey.delete(k); // re-insert last: Map order is recency order
    byKey.set(k, { ...old, ...toCrateTrack(t, from, now + i / 1000) });
  });
  const next = [...byKey.values()].slice(-CRATE_MAX);
  saveCrate(next);
  return next;
}

export function removeFromCrate(id: string): CrateTrack[] {
  const next = loadCrate().filter((c) => c.id !== id);
  saveCrate(next);
  return next;
}

export function clearCrate(): CrateTrack[] {
  saveCrate([]);
  return [];
}

export const isCrateComplete = (c: CrateTrack): boolean => isComplete({ ...c, sources: {} });

/** What one suggest request carries: not the set's own tracks, complete ones first, then most recent, capped. */
export function crateForRequest(crate: CrateTrack[], set: Track[]): CrateTrack[] {
  const inSet = new Set(set.flatMap((t) => [t.id, keyOf(t)]));
  return crate
    .filter((c) => !inSet.has(c.id) && !inSet.has(keyOf(c)))
    .map((c) => ({ c, complete: isCrateComplete(c) }))
    .sort((a, b) => Number(b.complete) - Number(a.complete) || b.c.addedAt - a.c.addedAt)
    .slice(0, CRATE_SEND_MAX)
    .map((x) => x.c);
}
