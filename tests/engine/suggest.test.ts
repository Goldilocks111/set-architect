import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, suggestNext } from '@/engine/suggest';
import { trackKeyOf, type Track } from '@/types/track';

const t = (id: string, o: Partial<Track> = {}): Track => ({
  id,
  artist: `Artist ${id}`,
  title: `Title ${id}`,
  sources: {},
  ...o,
});
const base = { template: '60min' as const, plannedLength: 15 };
const reason = (s: { reasons: Array<{ kind: string; label: string; score: number }> }, kind: string) =>
  s.reasons.find((r) => r.kind === kind);

describe('suggestNext', () => {
  const last = t('last', { bpm: 128, camelot: '8A', energy: 5 });

  it('exports default weights', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ key: 0.3, bpm: 0.2, energy: 0.2, cooccurrence: 0.2, similarity: 0.1 });
  });

  it('composite = weighted sum of reason scores', () => {
    const c = t('c', { bpm: 128, camelot: '8A', energy: 5 });
    const [s] = suggestNext({ ...base, playlist: [t('a'), t('b'), last], candidates: [c] });
    const sum = s.reasons.reduce((acc, r) => acc + r.score * DEFAULT_WEIGHTS[r.kind], 0);
    expect(s.score).toBeCloseTo(sum, 10);
  });

  it('custom weights change ranking', () => {
    const keyGood = t('k', { bpm: 140, camelot: '8A', energy: 5 });
    const bpmGood = t('b', { bpm: 128, camelot: '2A', energy: 5 });
    const run = (w: typeof DEFAULT_WEIGHTS) =>
      suggestNext({ ...base, playlist: [last], candidates: [keyGood, bpmGood], weights: w })[0].track.id;
    expect(run({ ...DEFAULT_WEIGHTS, key: 1, bpm: 0 })).toBe('k');
    expect(run({ ...DEFAULT_WEIGHTS, key: 0, bpm: 1 })).toBe('b');
  });

  it('hard-filters when key<0.3 AND bpm<0.3', () => {
    const bad = t('bad', { bpm: 160, camelot: '2A', energy: 5 });
    const keyOnly = t('ok1', { bpm: 160, camelot: '8A', energy: 5 });
    const bpmOnly = t('ok2', { bpm: 128, camelot: '2A', energy: 5 });
    const ids = suggestNext({ ...base, playlist: [last], candidates: [bad, keyOnly, bpmOnly] }).map((s) => s.track.id);
    expect(ids).not.toContain('bad');
    expect(ids).toEqual(expect.arrayContaining(['ok1', 'ok2']));
  });

  it('excludes tracks already in the playlist', () => {
    const c = t('x', { bpm: 128, camelot: '8A', energy: 5 });
    expect(suggestNext({ ...base, playlist: [last, c], candidates: [c] })).toHaveLength(0);
  });

  it('keeps partial-data tracks, marking unknowns', () => {
    const noBpm = t('nb', { camelot: '8A', energy: 5 });
    const noKey = t('nk', { bpm: 128, energy: 5 });
    const res = suggestNext({ ...base, playlist: [last], candidates: [noBpm, noKey] });
    expect(res).toHaveLength(2);
    const nb = res.find((s) => s.track.id === 'nb')!;
    const nk = res.find((s) => s.track.id === 'nk')!;
    expect(reason(nb, 'bpm')!.label).toMatch(/unknown/i);
    expect(reason(nk, 'key')!.label).toMatch(/unknown/i);
  });

  it('adjacency boosts and explains', () => {
    const a = t('a', { bpm: 128, camelot: '8A', energy: 5 });
    const b = t('b', { bpm: 128, camelot: '8A', energy: 5 });
    const adjacency = new Map([[trackKeyOf(b.artist, b.title), 3]]);
    const res = suggestNext({ ...base, playlist: [last], candidates: [a, b], adjacency });
    expect(res[0].track.id).toBe('b');
    expect(reason(res[0], 'cooccurrence')!.label).toBe('Played after Title last in 3 real sets');
    expect(reason(res[1], 'cooccurrence')).toBeUndefined();
  });

  it('similarity map adds a similarity reason', () => {
    const a = t('a', { bpm: 128, camelot: '8A', energy: 5 });
    const similarity = new Map([[trackKeyOf(a.artist, a.title), 0.8]]);
    const [s] = suggestNext({ ...base, playlist: [last], candidates: [a], similarity });
    expect(reason(s, 'similarity')!.score).toBeCloseTo(0.8);
  });

  it('empty playlist ranks by arc-start fit', () => {
    const fit = t('fit', { bpm: 124, camelot: '5A', energy: 4 });
    const peak = t('peak', { bpm: 124, camelot: '5A', energy: 9 });
    const res = suggestNext({ ...base, playlist: [], candidates: [peak, fit] });
    expect(res.map((s) => s.track.id)).toEqual(['fit', 'peak']);
  });

  it('ΔE=+2 only allowed with the +2 key energy boost', () => {
    const jumpBadKey = t('j1', { bpm: 128, camelot: '8A', energy: 7 });
    const jumpBoost = t('j2', { bpm: 128, camelot: '10A', energy: 7 });
    const ids = suggestNext({ ...base, playlist: [last], candidates: [jumpBadKey, jumpBoost] }).map((s) => s.track.id);
    expect(ids).toEqual(['j2']);
  });

  it('excludes +3 jumps even when key is unknown; keeps +2 with unknown key', () => {
    const j3 = t('j3', { bpm: 128, energy: 8 });
    const j2 = t('j2u', { bpm: 128, energy: 7 });
    const ids = suggestNext({ ...base, playlist: [last], candidates: [j3, j2] }).map((s) => s.track.id);
    expect(ids).toEqual(['j2u']);
  });

  it('penalizes a fifth consecutive track at the same energy', () => {
    const flat = Array.from({ length: 4 }, (_, i) => t(`f${i}`, { bpm: 128, camelot: '8A', energy: 5 }));
    const same = t('same', { bpm: 128, camelot: '8A', energy: 5 });
    const [s] = suggestNext({ ...base, playlist: flat, candidates: [same] });
    expect(reason(s, 'energy')!.label).toMatch(/flat/i);
    expect(reason(s, 'energy')!.score).toBeLessThan(1);
  });

  it('returns at most 10, sorted by score desc', () => {
    const cands = Array.from({ length: 15 }, (_, i) => t(`c${i}`, { bpm: 128 + (i % 4), camelot: '8A', energy: 5 }));
    const res = suggestNext({ ...base, playlist: [last], candidates: cands });
    expect(res).toHaveLength(10);
    for (let i = 1; i < res.length; i++) expect(res[i - 1].score).toBeGreaterThanOrEqual(res[i].score);
  });
});
