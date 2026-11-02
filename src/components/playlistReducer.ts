import { DANCEABILITY_PRIOR_SOURCE, ESSENTIALS, missingEssentials, withDanceabilityPrior, type IncompleteReason } from '@/lib/completeness';
import { clampPlayFraction, DEFAULT_ARC, DEFAULT_PLAY_FRACTION, toArc } from '@/lib/arc';
import type { Arc, Track } from '@/types/track';
import { isInSet, recordingKeys } from './recordingKeys';
import { sanitizeTrack } from './trackSanitize';

export interface PlaylistState {
  tracks: Track[];
  arc: Arc;
  /** Share of each track played before the next is mixed in (0.5-1). */
  playFraction: number;
  /** ids with a resolve request in flight; client-only, never persisted. */
  resolving?: string[];
}

/** What a load accepts: a saved set carries tracks + arc only; missing fields fall back. */
export type LoadableState = Pick<PlaylistState, 'tracks'> & Partial<Omit<PlaylistState, 'tracks'>>;

export type PlaylistAction =
  | { type: 'add'; track: Track }
  | { type: 'remove'; id: string }
  | { type: 'reorder'; from: number; to: number }
  | { type: 'clear' }
  | { type: 'setArc'; arc: Arc }
  | { type: 'setPlayFraction'; playFraction: number }
  | { type: 'load'; state: LoadableState }
  | { type: 'enrich'; id: string; fields: Partial<Track> }
  | { type: 'resolveStart'; id: string }
  | { type: 'resolved'; id: string; track: Track }
  | { type: 'resolveFailed'; id: string; reason: IncompleteReason }
  | { type: 'override'; id: string; fields: Partial<Pick<Track, (typeof ESSENTIALS)[number] | 'durationMs'>> };

export const initialPlaylistState: PlaylistState = { tracks: [], arc: DEFAULT_ARC, playFraction: DEFAULT_PLAY_FRACTION };

/** Fills fields the track doesn't have yet; never overwrites known values or the id (except a danceability prior, which a real value replaces). */
export function enrichTrack(track: Track, fields: Partial<Track>): Track {
  const out: Track = { ...track, sources: { ...track.sources } };
  for (const [k, v] of Object.entries(fields) as Array<[keyof Track, unknown]>) {
    if (k === 'id' || k === 'sources' || v === undefined) continue;
    const src = fields.sources?.[k];
    const replacesPrior = out.sources[k] === DANCEABILITY_PRIOR_SOURCE && src !== undefined && src !== DANCEABILITY_PRIOR_SOURCE;
    if (out[k] !== undefined && !replacesPrior) continue;
    (out as unknown as Record<string, unknown>)[k] = v;
    if (src) out.sources[k] = src;
  }
  return out;
}

/** Recomputes `unresolved` from the fields actually present; `reason` is used only while something is missing. */
function settleTrack(track: Track, reason: IncompleteReason, retryAt?: number): Track {
  const missing = missingEssentials(track);
  const { unresolved: _old, ...rest } = track;
  void _old;
  return missing.length ? { ...rest, unresolved: { reason, missing, ...(retryAt !== undefined ? { retryAt } : {}) } } : rest;
}

/** Fills gaps from a resolver answer (never overwrites known or manual values) and adopts its verdict. */
export function applyResolved(track: Track, resolved: Track): Track {
  const { unresolved, ...fields } = resolved;
  const merged = enrichTrack(track, fields);
  return settleTrack(merged, unresolved?.reason ?? track.unresolved?.reason ?? 'not-found', unresolved?.retryAt);
}

const without = (ids: string[] | undefined, id: string) => (ids ?? []).filter((x) => x !== id);

function updateTrack(state: PlaylistState, id: string, fn: (t: Track) => Track): PlaylistState {
  const i = state.tracks.findIndex((t) => t.id === id);
  if (i < 0) return state;
  const tracks = [...state.tracks];
  tracks[i] = fn(tracks[i]);
  return { ...state, tracks };
}

export function playlistReducer(state: PlaylistState, action: PlaylistAction): PlaylistState {
  switch (action.type) {
    case 'add': {
      const existing = new Set(state.tracks.flatMap(recordingKeys));
      if (isInSet(existing, action.track)) return state;
      return { ...state, tracks: [...state.tracks, action.track] };
    }
    case 'remove':
      return { ...state, tracks: state.tracks.filter((t) => t.id !== action.id) };
    case 'reorder': {
      const { from, to } = action;
      const n = state.tracks.length;
      if (from === to || from < 0 || to < 0 || from >= n || to >= n) return state;
      const tracks = [...state.tracks];
      const [moved] = tracks.splice(from, 1);
      tracks.splice(to, 0, moved);
      return { ...state, tracks };
    }
    case 'clear':
      return { ...state, tracks: [] };
    case 'setArc':
      return { ...state, arc: toArc(action.arc) };
    case 'setPlayFraction':
      return { ...state, playFraction: clampPlayFraction(action.playFraction) };
    case 'enrich': {
      const i = state.tracks.findIndex((t) => t.id === action.id);
      if (i < 0) return state;
      const tracks = [...state.tracks];
      tracks[i] = enrichTrack(tracks[i], action.fields);
      return { ...state, tracks };
    }
    case 'resolveStart':
      return state.resolving?.includes(action.id) ? state : { ...state, resolving: [...(state.resolving ?? []), action.id] };
    case 'resolved':
      return { ...updateTrack(state, action.id, (t) => applyResolved(t, action.track)), resolving: without(state.resolving, action.id) };
    case 'resolveFailed':
      return {
        ...updateTrack(state, action.id, (t) => settleTrack(t, action.reason)),
        resolving: without(state.resolving, action.id),
      };
    case 'override':
      return updateTrack(state, action.id, (t) => {
        const out: Track = { ...t, sources: { ...t.sources } };
        for (const f of [...ESSENTIALS, 'durationMs'] as const) {
          const v = action.fields[f];
          if (v === undefined) continue;
          (out as unknown as Record<string, unknown>)[f] = v;
          out.sources[f] = 'manual';
        }
        // same rule as the server's metadata cache: a manual/MIK row with energy is completed by the danceability prior
        return settleTrack(withDanceabilityPrior(out), t.unresolved?.reason ?? 'not-found', t.unresolved?.retryAt);
      });
    case 'load': {
      // `template` is the pre-minute-arc field ('60min' / '120min') of old localStorage and saved sets.
      const s = action.state as (Partial<PlaylistState> & { template?: unknown }) | null;
      if (!s || typeof s !== 'object' || !Array.isArray(s.tracks)) return initialPlaylistState;
      return {
        arc: toArc(s.arc ?? s.template),
        // a saved set carries no fraction: it keeps the DJ's current setting
        playFraction: s.playFraction === undefined ? state.playFraction : clampPlayFraction(s.playFraction),
        tracks: s.tracks.map(sanitizeTrack).filter((t): t is Track => t !== null),
      };
    }
  }
}
