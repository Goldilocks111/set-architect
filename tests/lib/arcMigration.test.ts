import { afterEach, describe, expect, it } from 'vitest';
import { arcLabel, clampPlayFraction, DEFAULT_ARC, DEFAULT_PLAY_FRACTION, encodeArc, toArc } from '@/lib/arc';
import { initialPlaylistState, playlistReducer, type PlaylistState } from '@/components/playlistReducer';
import { loadLocal, saveLocal, STORAGE_KEY } from '@/components/persistence';
import type { Track } from '@/types/track';

const tr = (id: string): Track => ({ id, artist: `A${id}`, title: `T${id}`, sources: {}, bpm: 124, durationMs: 300_000 });

describe('toArc', () => {
  it("migrates the old templates: '60min' -> {60,'build'}, '120min' -> {120,'journey'}", () => {
    expect(toArc('60min')).toEqual({ minutes: 60, shape: 'build' });
    expect(toArc('120min')).toEqual({ minutes: 120, shape: 'journey' });
  });
  it('keeps a valid arc, clamps custom lengths to 15-480 whole minutes', () => {
    expect(toArc({ minutes: 90, shape: 'peak-time' })).toEqual({ minutes: 90, shape: 'peak-time' });
    expect(toArc({ minutes: 5, shape: 'warm-up' })).toEqual({ minutes: 15, shape: 'warm-up' });
    expect(toArc({ minutes: 9999, shape: 'journey' })).toEqual({ minutes: 480, shape: 'journey' });
    expect(toArc({ minutes: 72.6, shape: 'build' })).toEqual({ minutes: 73, shape: 'build' });
  });
  it('falls back per field: a bad shape keeps the length, a bad length keeps the shape', () => {
    expect(toArc({ minutes: 90, shape: 'rave' })).toEqual({ minutes: 90, shape: 'build' });
    expect(toArc({ minutes: 'x', shape: 'journey' })).toEqual({ minutes: 60, shape: 'journey' });
    expect(toArc({ minutes: Number.NaN, shape: 'journey' })).toEqual({ minutes: 60, shape: 'journey' });
  });
  it('anything else is the default 60-minute build', () => {
    for (const v of [undefined, null, '', '90min', 42, [], 'junk']) expect(toArc(v)).toEqual(DEFAULT_ARC);
    expect(DEFAULT_ARC).toEqual({ minutes: 60, shape: 'build' });
  });
  it('round-trips through the text column encoding, and reads legacy column values', () => {
    for (const a of [{ minutes: 60, shape: 'build' }, { minutes: 240, shape: 'peak-time' }, { minutes: 15, shape: 'warm-up' }] as const) {
      expect(toArc(encodeArc(a))).toEqual(a);
    }
    expect(encodeArc({ minutes: 90, shape: 'journey' })).toBe('90min:journey');
  });
  it('labels', () => {
    expect(arcLabel({ minutes: 60, shape: 'build' })).toBe('60 min build');
    expect(arcLabel({ minutes: 240, shape: 'peak-time' })).toBe('240 min peak time');
  });
});

describe('clampPlayFraction', () => {
  it('50-100%, default 75%', () => {
    expect(DEFAULT_PLAY_FRACTION).toBe(0.75);
    expect(clampPlayFraction(0.6)).toBe(0.6);
    expect(clampPlayFraction(0.2)).toBe(0.5);
    expect(clampPlayFraction(1.4)).toBe(1);
    for (const v of [undefined, null, 'x', Number.NaN, Infinity]) expect(clampPlayFraction(v)).toBe(0.75);
  });
});

describe('playlistReducer arc + play fraction', () => {
  it('starts on the 60-minute build at 75%', () => {
    expect(initialPlaylistState.arc).toEqual({ minutes: 60, shape: 'build' });
    expect(initialPlaylistState.playFraction).toBe(0.75);
  });
  it('setArc / setPlayFraction validate their input', () => {
    let s = playlistReducer(initialPlaylistState, { type: 'setArc', arc: { minutes: 1000, shape: 'journey' } });
    expect(s.arc).toEqual({ minutes: 480, shape: 'journey' });
    s = playlistReducer(s, { type: 'setPlayFraction', playFraction: 0.3 });
    expect(s.playFraction).toBe(0.5);
    s = playlistReducer(s, { type: 'clear' });
    expect(s.arc).toEqual({ minutes: 480, shape: 'journey' });
    expect(s.playFraction).toBe(0.5);
  });
  it("loads old state with template '60min' / '120min' without losing tracks", () => {
    for (const [template, arc] of [['60min', { minutes: 60, shape: 'build' }], ['120min', { minutes: 120, shape: 'journey' }]] as const) {
      const s = playlistReducer(initialPlaylistState, {
        type: 'load',
        state: { template, tracks: [tr('a'), tr('b'), tr('c')] } as unknown as PlaylistState,
      });
      expect(s.arc).toEqual(arc);
      expect(s.tracks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
      expect(s.tracks[0].durationMs).toBe(300_000);
      expect(s).not.toHaveProperty('template');
    }
  });
  it('a new arc wins over a stale template; play fraction loads when present, else keeps the current one', () => {
    const cur = { ...initialPlaylistState, playFraction: 0.6 };
    const s = playlistReducer(cur, {
      type: 'load',
      state: { template: '120min', arc: { minutes: 180, shape: 'peak-time' }, tracks: [] } as unknown as PlaylistState,
    });
    expect(s.arc).toEqual({ minutes: 180, shape: 'peak-time' });
    expect(s.playFraction).toBe(0.6);
    const t = playlistReducer(cur, { type: 'load', state: { arc: { minutes: 90, shape: 'build' }, playFraction: 0.9, tracks: [] } });
    expect(t.playFraction).toBe(0.9);
  });
});

describe('localStorage', () => {
  afterEach(() => window.localStorage.clear());
  it("an old saved '120min' state migrates on load", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '120min', tracks: [tr('x')] }));
    const s = playlistReducer(initialPlaylistState, { type: 'load', state: loadLocal()! });
    expect(s.arc).toEqual({ minutes: 120, shape: 'journey' });
    expect(s.tracks.map((t) => t.id)).toEqual(['x']);
  });
  it('arc and play fraction are persisted and restored', () => {
    saveLocal({ tracks: [tr('y')], arc: { minutes: 240, shape: 'peak-time' }, playFraction: 0.85, resolving: ['y'] });
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(raw.arc).toEqual({ minutes: 240, shape: 'peak-time' });
    expect(raw.playFraction).toBe(0.85);
    expect(raw).not.toHaveProperty('resolving');
    const s = playlistReducer(initialPlaylistState, { type: 'load', state: loadLocal()! });
    expect(s.arc).toEqual({ minutes: 240, shape: 'peak-time' });
    expect(s.playFraction).toBe(0.85);
  });
});

describe('saved sets (Supabase arc_template column)', () => {
  it("legacy rows ('60min' / '120min') load as arcs; new rows round-trip", () => {
    expect(toArc('60min')).toEqual({ minutes: 60, shape: 'build' });
    expect(toArc('120min')).toEqual({ minutes: 120, shape: 'journey' });
    expect(toArc('150min:warm-up')).toEqual({ minutes: 150, shape: 'warm-up' });
    expect(toArc(null)).toEqual({ minutes: 60, shape: 'build' });
  });
});
