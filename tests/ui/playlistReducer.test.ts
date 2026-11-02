import { describe, expect, it } from 'vitest';
import {
  initialPlaylistState,
  playlistReducer,
  applyResolved,
  type PlaylistState,
} from '@/components/playlistReducer';
import type { Track } from '@/types/track';

const t = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  artist: `Artist ${id}`,
  title: `Title ${id}`,
  sources: {},
  ...extra,
});

const withTracks = (...ids: string[]): PlaylistState => ({
  ...initialPlaylistState,
  tracks: ids.map((id) => t(id)),
});

describe('playlistReducer', () => {
  it('starts empty on the 60-minute build arc', () => {
    expect(initialPlaylistState.tracks).toEqual([]);
    expect(initialPlaylistState.arc).toEqual({ minutes: 60, shape: 'build' });
  });

  it('adds a track to the end', () => {
    const s = playlistReducer(withTracks('a'), { type: 'add', track: t('b') });
    expect(s.tracks.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('ignores adding a track already in the set', () => {
    const before = withTracks('a', 'b');
    const s = playlistReducer(before, { type: 'add', track: t('a') });
    expect(s).toBe(before);
  });

  it('removes a track by id', () => {
    const s = playlistReducer(withTracks('a', 'b', 'c'), { type: 'remove', id: 'b' });
    expect(s.tracks.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('reorders: moves an item from one index to another', () => {
    const s = playlistReducer(withTracks('a', 'b', 'c', 'd'), { type: 'reorder', from: 0, to: 2 });
    expect(s.tracks.map((x) => x.id)).toEqual(['b', 'c', 'a', 'd']);
    const back = playlistReducer(s, { type: 'reorder', from: 2, to: 0 });
    expect(back.tracks.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reorder with out-of-range indices is a no-op', () => {
    const before = withTracks('a', 'b');
    expect(playlistReducer(before, { type: 'reorder', from: 0, to: 5 })).toBe(before);
    expect(playlistReducer(before, { type: 'reorder', from: -1, to: 0 })).toBe(before);
    expect(playlistReducer(before, { type: 'reorder', from: 1, to: 1 })).toBe(before);
  });

  it('clears all tracks but keeps the arc', () => {
    const s = playlistReducer(
      { ...withTracks('a', 'b'), arc: { minutes: 120, shape: 'journey' } },
      { type: 'clear' }
    );
    expect(s.tracks).toEqual([]);
    expect(s.arc).toEqual({ minutes: 120, shape: 'journey' });
  });

  it('sets the arc', () => {
    const s = playlistReducer(withTracks('a'), { type: 'setArc', arc: { minutes: 90, shape: 'peak-time' } });
    expect(s.arc).toEqual({ minutes: 90, shape: 'peak-time' });
    expect(s.tracks).toHaveLength(1);
  });

  it('loads a persisted state, dropping malformed tracks', () => {
    const s = playlistReducer(initialPlaylistState, {
      type: 'load',
      state: {
        arc: { minutes: 120, shape: 'journey' },
        playFraction: 0.75,
        tracks: [t('x'), { nope: true } as unknown as Track, t('y')],
      },
    });
    expect(s.arc).toEqual({ minutes: 120, shape: 'journey' });
    expect(s.tracks.map((x) => x.id)).toEqual(['x', 'y']);
  });

  it('load with garbage falls back to the initial state', () => {
    const s = playlistReducer(withTracks('a'), { type: 'load', state: 'junk' as unknown as PlaylistState });
    expect(s).toEqual(initialPlaylistState);
  });

  it('enrich fills only missing fields of the matching track and merges provenance', () => {
    const before: PlaylistState = {
      ...initialPlaylistState,
      tracks: [t('a', { bpm: 124, sources: { bpm: 'deezer' } }), t('b')],
    };
    const s = playlistReducer(before, {
      type: 'enrich',
      id: 'a',
      fields: { id: 'other', bpm: 999, camelot: '8A', energy: 6, sources: { bpm: 'getsongbpm', camelot: 'getsongbpm' } },
    });
    expect(s.tracks[0]).toMatchObject({ id: 'a', bpm: 124, camelot: '8A', energy: 6 });
    expect(s.tracks[0].sources).toEqual({ bpm: 'deezer', camelot: 'getsongbpm' });
    expect(s.tracks[1]).toBe(before.tracks[1]);
  });

  it('enrich for a track no longer in the set is a no-op', () => {
    const before = withTracks('a');
    expect(playlistReducer(before, { type: 'enrich', id: 'zzz', fields: { bpm: 1 } })).toBe(before);
  });
});

describe('durationMs through the reducer', () => {
  it("a search hit's exact-version length survives a resolver answer carrying another length", () => {
    const merged = applyResolved(t('h', { durationMs: 390000 }), t('h', { durationMs: 210000, bpm: 124 }));
    expect(merged.durationMs).toBe(390000);
    expect(merged.bpm).toBe(124);
  });
  it('override applies a manual durationMs', () => {
    const s = playlistReducer(
      { ...initialPlaylistState, tracks: [t('a')] },
      { type: 'override', id: 'a', fields: { durationMs: 401000 } }
    );
    expect(s.tracks[0].durationMs).toBe(401000);
    expect(s.tracks[0].sources.durationMs).toBe('manual');
  });
});
