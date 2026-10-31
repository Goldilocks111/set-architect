import type { ArcTemplate, Track } from '@/types/track';
import { sanitizeTrack } from './trackSanitize';

export interface PlaylistState {
  tracks: Track[];
  template: ArcTemplate;
}

export type PlaylistAction =
  | { type: 'add'; track: Track }
  | { type: 'remove'; id: string }
  | { type: 'reorder'; from: number; to: number }
  | { type: 'clear' }
  | { type: 'setTemplate'; template: ArcTemplate }
  | { type: 'load'; state: PlaylistState }
  | { type: 'enrich'; id: string; fields: Partial<Track> };

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

export function playlistReducer(state: PlaylistState, action: PlaylistAction): PlaylistState {
  switch (action.type) {
    case 'add':
      if (state.tracks.some((t) => t.id === action.track.id)) return state;
      return { ...state, tracks: [...state.tracks, action.track] };
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
