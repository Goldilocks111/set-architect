import { ESSENTIALS, missingEssentials, type IncompleteReason } from '@/lib/completeness';
import type { ArcTemplate, Track } from '@/types/track';
import { isInSet, recordingKeys } from './recordingKeys';
import { sanitizeTrack } from './trackSanitize';

export interface PlaylistState {
  tracks: Track[];
  template: ArcTemplate;
  /** ids with a resolve request in flight; client-only, never persisted. */
  resolving?: string[];
}

export type PlaylistAction =
  | { type: 'add'; track: Track }
  | { type: 'remove'; id: string }
  | { type: 'reorder'; from: number; to: number }
  | { type: 'clear' }
  | { type: 'setTemplate'; template: ArcTemplate }
  | { type: 'load'; state: PlaylistState }
  | { type: 'enrich'; id: string; fields: Partial<Track> }
  | { type: 'resolveStart'; id: string }
  | { type: 'resolved'; id: string; track: Track }
  | { type: 'resolveFailed'; id: string; reason: IncompleteReason }
  | { type: 'override'; id: string; fields: Partial<Pick<Track, (typeof ESSENTIALS)[number]>> };

export const initialPlaylistState: PlaylistState = { tracks: [], template: '60min' };

/** ~15 tracks per hour (mixing rulebook §3). */
export function plannedLengthFor(template: ArcTemplate): number {
  return template === '120min' ? 30 : 15;
}

const isTemplate = (v: unknown): v is ArcTemplate => v === '60min' || v === '120min';

/** Fills fields the track doesn't have yet; never overwrites known values or the id. */
export function enrichTrack(track: Track, fields: Partial<Track>): Track {
  const out: Track = { ...track, sources: { ...track.sources } };
  for (const [k, v] of Object.entries(fields) as Array<[keyof Track, unknown]>) {
    if (k === 'id' || k === 'sources' || v === undefined || out[k] !== undefined) continue;
    (out as unknown as Record<string, unknown>)[k] = v;
    const src = fields.sources?.[k];
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
    case 'setTemplate':
      return { ...state, template: action.template };
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
        for (const f of ESSENTIALS) {
          const v = action.fields[f];
          if (v === undefined) continue;
          (out as unknown as Record<string, unknown>)[f] = v;
          out.sources[f] = 'manual';
        }
        return settleTrack(out, t.unresolved?.reason ?? 'not-found', t.unresolved?.retryAt);
      });
    case 'load': {
      const s = action.state as Partial<PlaylistState> | null;
      if (!s || typeof s !== 'object' || !Array.isArray(s.tracks)) return initialPlaylistState;
      return {
        template: isTemplate(s.template) ? s.template : initialPlaylistState.template,
        tracks: s.tracks.map(sanitizeTrack).filter((t): t is Track => t !== null),
      };
    }
  }
}
