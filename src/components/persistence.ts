import type { PlaylistState } from './playlistReducer';

export const STORAGE_KEY = 'setarch:playlist:v1';

export function loadLocal(): PlaylistState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PlaylistState) : null;
  } catch {
    return null;
  }
}

export function saveLocal(state: PlaylistState): void {
  try {
    // Preview URLs are signed/short-lived (Deezer ~15 min) and must not be persisted.
    const { resolving: _resolving, orderUndo: _undo, ...persisted } = state; // in-flight state and undo are client-only
    void _resolving;
    void _undo;
    const tracks = state.tracks.map(({ previewUrl: _drop, ...rest }) => {
      void _drop;
      const sources = { ...rest.sources };
      delete sources.previewUrl;
      return { ...rest, sources };
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...persisted, tracks }));
  } catch {
    // storage blocked or full: the set still lives in memory for this session
  }
}
