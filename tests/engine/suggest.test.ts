import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, primaryArtist, suggestNext } from '@/engine/suggest';
import { trackKeyOf, type Track } from '@/types/track';

const t = (id: string, o: Partial<Track> = {}): Track => ({
  id,
  artist: `Artist ${id}`,
  title: `Title ${id}`,
  sources: {},
  danceability: 0.6,
  ...o,
});
const base = { template: '60min' as const, plannedLength: 15 };
const reason = (s: { reasons: Array<{ kind: string; label: string; score: number }> }, kind: string) =>
  s.reasons.find((r) => r.kind === kind);

describe('suggestNext', () => {
  const last = t('last', { bpm: 128, camelot: '8A', energy: 5 });

  it('exports default weights', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ key: 0.25, bpm: 0.15, energy: 0.2, cooccurrence: 0.15, similarity: 0.1, style: 0.15 });
  });

  it('composite = weighted sum of reason scores', () => {
    const c = t('c', { bpm: 128, camelot: '8A', energy: 5 });
    const [s] = suggestNext({ ...base, playlist: [t('a'), t('b'), last], candidates: [c] });
    // No lanes on either side: style scores a neutral 0.5 with no reason.
    const sum = s.reasons.reduce((acc, r) => acc + r.score * DEFAULT_WEIGHTS[r.kind], 0) + 0.5 * DEFAULT_WEIGHTS.style;
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

  it('keeps tracks whose bpm/key are present but unusable, marking unknowns', () => {
    const noBpm = t('nb', { bpm: 0, camelot: '8A', energy: 5 });
    const noKey = t('nk', { bpm: 128, camelot: 'garbage', energy: 5 });
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
    const j3 = t('j3', { bpm: 128, camelot: 'garbage', energy: 8 });
    const j2 = t('j2u', { bpm: 128, camelot: 'garbage', energy: 7 });
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

  describe('incomplete tracks (excluded, not mis-scored)', () => {
    const full = { bpm: 128, camelot: '8A', energy: 5, danceability: 0.6 };

    it('never returns incomplete candidates, including danceability-only gaps', () => {
      const ids = suggestNext({
        ...base,
        playlist: [t('p', full)],
        candidates: [
          t('ok', full),
          t('noDance', { ...full, danceability: undefined }),
          t('noKey', { ...full, camelot: undefined }),
          t('noBpm', { ...full, bpm: undefined }),
          t('noEnergy', { ...full, energy: undefined }),
        ],
      }).map((s) => s.track.id);
      expect(ids).toEqual(['ok']);
    });

    it('uses the last complete track as `last`, while arc position counts every track', () => {
      const complete = t('c', { bpm: 128, camelot: '8A', energy: 5, danceability: 0.6 });
      const pending = t('inc', { bpm: 90 });
      const cand = t('n', { bpm: 128, camelot: '9A', energy: 5, danceability: 0.6 });
      const [s] = suggestNext({ ...base, playlist: [complete, pending], candidates: [cand] });
      expect(reason(s, 'key')?.label).toContain('8A → 9A');
      expect(reason(s, 'bpm')?.label).not.toMatch(/unknown/i);
      // Arc position counts the incomplete track: same score as a 2-track set ending in an identical complete track.
      const twin = suggestNext({ ...base, playlist: [complete, t('c2', full)], candidates: [cand] })[0];
      expect(twin.score).toBe(s.score);
    });

    it('all-incomplete playlist scores as an arc start with an explanatory reason', () => {
      const cand = t('n', full);
      const res = suggestNext({ ...base, playlist: [t('i1', { bpm: 100 }), t('i2')], candidates: [cand] });
      expect(res).toHaveLength(1);
      const kinds = res[0].reasons.map((r) => r.kind);
      expect(kinds).not.toContain('key');
      expect(kinds).not.toContain('bpm');
      expect(res[0].reasons).toContainEqual(
        expect.objectContaining({ kind: 'energy', label: 'Set tracks still resolving — scored from arc start' })
      );
      // no anchor to verify key/tempo against: compliance falls back to the opener rule (energy within 1 of target 4)
      expect(res[0].compliant).toBe(true);
      const off = suggestNext({ ...base, playlist: [t('i1', { bpm: 100 }), t('i2')], candidates: [t('o', { ...full, energy: 7 })] });
      expect(off[0].compliant).toBe(false);
    });

    it('empty playlist keeps the plain arc-start wording', () => {
      const [s] = suggestNext({ ...base, playlist: [], candidates: [t('n', full)] });
      expect(reason(s, 'energy')?.label).not.toMatch(/resolving/);
    });
  });

  describe('style (lane fit)', () => {
    const full = { bpm: 128, camelot: '8A', energy: 5, danceability: 0.6 };

    it('unknown style is neutral (scored 0.5, no penalty, no reason)', () => {
      const set = [t('p', { ...full, styles: ['techno'] })];
      const tagged = t('tagged', { ...full, styles: ['techno'] });
      const untagged = t('untagged', full);
      const offLane = t('off', { ...full, styles: ['drum-and-bass'] });
      const res = suggestNext({ ...base, playlist: set, candidates: [tagged, untagged, offLane] });
      const by = (id: string) => res.find((s) => s.track.id === id)!;
      expect(reason(by('untagged'), 'style')).toBeUndefined();
      const noStyle = by('untagged').reasons.reduce((a, r) => a + r.score * DEFAULT_WEIGHTS[r.kind], 0);
      expect(by('untagged').score).toBeCloseTo(noStyle + 0.5 * DEFAULT_WEIGHTS.style, 10);
      // neutral sits between an on-lane and an off-lane track, never below the off-lane one
      expect(by('untagged').score).toBeLessThan(by('tagged').score);
      expect(by('untagged').score).toBeGreaterThan(by('off').score);
      // an untagged set is neutral for every candidate
      const plain = suggestNext({ ...base, playlist: [t('p2', full)], candidates: [tagged, untagged] });
      expect(plain[0].score).toBeCloseTo(plain[1].score, 10);
      expect(plain.every((s) => !reason(s, 'style'))).toBe(true);
    });

    it('lane follows recency and shows a style reason', () => {
      const set = [
        ...Array.from({ length: 6 }, (_, i) => t(`m${i}`, { ...full, styles: ['melodic-techno'] })),
        ...Array.from({ length: 3 }, (_, i) => t(`x${i}`, { ...full, styles: ['techno'] })),
      ];
      const res = suggestNext({
        ...base,
        playlist: set,
        candidates: [t('mel', { ...full, styles: ['melodic-techno'] }), t('tec', { ...full, styles: ['techno'] })],
      });
      expect(res[0].track.id).toBe('tec');
      expect(reason(res[0], 'style')?.label).toBe('Same lane: techno');
      // the opener's lane only weighs .4 + .2 against the recent techno run
      expect(reason(res[1], 'style')!.score).toBeLessThan(0.3);
    });

    it('custom weights accept a style weight', () => {
      const set = [t('p', { ...full, styles: ['techno'] })];
      const cands = [t('on', { ...full, camelot: '9A', styles: ['techno'] }), t('off', { ...full, styles: ['trance'] })];
      expect(suggestNext({ ...base, playlist: set, candidates: cands })[0].track.id).toBe('on');
      expect(suggestNext({ ...base, playlist: set, candidates: cands, weights: { ...DEFAULT_WEIGHTS, style: 0 } })[0].track.id).toBe('off');
    });
  });

  describe('compliance-first ranking', () => {
    const full = { bpm: 128, camelot: '8A', energy: 5, danceability: 0.6 };

    it('sets `compliant` on every suggestion', () => {
      const res = suggestNext({
        ...base,
        playlist: [t('p', full)],
        candidates: [t('ok', full), t('far', { ...full, bpm: 140 })],
      });
      expect(res.find((s) => s.track.id === 'ok')!.compliant).toBe(true);
      expect(res.find((s) => s.track.id === 'far')!.compliant).toBe(false);
    });

    it('ranks every compliant candidate above every non-compliant one, each tier by score', () => {
      // Non-compliant but high-scoring: perfect key + tempo, strong co-occurrence and similarity, energy away from target.
      const set = [t('p', { ...full, energy: 5 })];
      const target = 4; // 60min, position 1 of 15
      // ΔE +1 to 6 moves away from target 4 and lands 2 from it → non-compliant
      const strong = Array.from({ length: 4 }, (_, i) => t(`n${i}`, { ...full, energy: 6 }));
      const weak = Array.from({ length: 4 }, (_, i) => t(`c${i}`, { ...full, camelot: i % 2 ? '7A' : '9A', bpm: 131 + i, energy: 4 }));
      const adjacency = new Map(strong.map((s) => [trackKeyOf(s.artist, s.title), 5]));
      const similarity = new Map(strong.map((s) => [trackKeyOf(s.artist, s.title), 1]));
      const res = suggestNext({ ...base, playlist: set, candidates: [...strong, ...weak], adjacency, similarity });
      expect(target).toBe(4);
      const flags = res.map((s) => s.compliant);
      expect(flags).toEqual([true, true, true, true, false, false, false, false]);
      // without the tiers the strong ones would win on score
      expect(Math.min(...res.slice(4).map((s) => s.score))).toBeGreaterThan(Math.max(...res.slice(0, 4).map((s) => s.score)));
      for (const tier of [res.slice(0, 4), res.slice(4)])
        for (let i = 1; i < tier.length; i++) expect(tier[i - 1].score).toBeGreaterThanOrEqual(tier[i].score);
    });

    it('first track of a set: compliant = energy within 1 of the arc target', () => {
      const res = suggestNext({
        ...base,
        playlist: [],
        candidates: [t('on', { ...full, energy: 4 }), t('near', { ...full, energy: 5 }), t('off', { ...full, energy: 7 })],
      });
      const by = (id: string) => res.find((s) => s.track.id === id)!;
      expect(by('on').compliant).toBe(true);
      expect(by('near').compliant).toBe(true);
      expect(by('off').compliant).toBe(false);
    });

    it('criterion 3 property: with ≥ 10 compliant candidates in the pool, the top-10 are all compliant', () => {
      // Deterministic pseudo-random scenarios (mulberry32): random sets, random pools, random adjacency/similarity/lanes.
      const rng = (seed: number) => () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
      const lanes = ['techno', 'melodic-techno', 'house', 'tech-house', 'trance'];
      let checked = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const r = rng(seed);
        const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
        const rand = (id: string): Track =>
          t(id, {
            bpm: 120 + Math.round(r() * 12),
            camelot: `${1 + Math.floor(r() * 12)}${r() < 0.5 ? 'A' : 'B'}`,
            energy: 1 + Math.floor(r() * 10),
            danceability: 0.6,
            ...(r() < 0.7 ? { styles: [pick(lanes)] } : {}),
          });
        const playlist = Array.from({ length: 1 + Math.floor(r() * 12) }, (_, i) => rand(`s${seed}-${i}`));
        const candidates = Array.from({ length: 150 }, (_, i) => rand(`c${seed}-${i}`));
        const adjacency = new Map<string, number>();
        const similarity = new Map<string, number>();
        for (const c of candidates) {
          if (r() < 0.3) adjacency.set(trackKeyOf(c.artist, c.title), 1 + Math.floor(r() * 6));
          if (r() < 0.3) similarity.set(trackKeyOf(c.artist, c.title), r());
        }
        const all = suggestNext({ ...base, plannedLength: 20, playlist, candidates, adjacency, similarity });
        const pool = suggestNext({ ...base, plannedLength: 20, playlist, candidates, adjacency, similarity, limit: Infinity });
        const poolCompliant = pool.filter((s) => s.compliant).length;
        if (poolCompliant < 10) continue;
        checked++;
        expect(all).toHaveLength(10);
        expect(all.filter((s) => s.compliant)).toHaveLength(10);
      }
      expect(checked).toBeGreaterThan(50);
    });
  });

  describe('artist diversity (at most 2 per primary artist)', () => {
    const lastT = t('last', { bpm: 128, camelot: '8A', energy: 5 });
    const good = { bpm: 128, camelot: '8A', energy: 5 };
    it('primaryArtist splits credits on whole words only', () => {
      for (const a of ['Featurecast', 'Ftampa', 'Vsevolod', 'X-Press 2', 'Xavier']) expect(primaryArtist(a), a).toBe(trackKeyOf(a, '').split('|')[0]);
      expect(primaryArtist('Same DJ feat. X')).toBe('same dj');
      expect(primaryArtist('A ft. B')).toBe('a');
      expect(primaryArtist('A vs. B')).toBe('a');
      expect(primaryArtist('A x B')).toBe('a');
      expect(primaryArtist('A, B')).toBe('a');
      expect(primaryArtist('A & B')).toBe('a');
    });
    it('5 same-artist high scorers: only 2 reach the top 10, the rest fill from further down', () => {
      const same = Array.from({ length: 5 }, (_, i) => t(`s${i}`, { artist: 'Same DJ', ...good }));
      const others = Array.from({ length: 10 }, (_, i) => t(`o${i}`, { bpm: 129, camelot: '8A', energy: 5 }));
      const out = suggestNext({ ...base, playlist: [lastT], candidates: [...same, ...others] });
      expect(out).toHaveLength(10);
      expect(out.filter((s) => s.track.artist === 'Same DJ')).toHaveLength(2);
    });
    it('primary artist = first credit, normalized ("Same DJ feat. X", "same dj & Y" count as Same DJ)', () => {
      const cs = ['Same DJ feat. X', 'same dj & Y', 'SAME DJ', 'Same DJ x Z'].map((a, i) => t(`c${i}`, { artist: a, ...good }));
      const others = Array.from({ length: 6 }, (_, i) => t(`o${i}`, { bpm: 129, camelot: '8A', energy: 5 }));
      const out = suggestNext({ ...base, playlist: [lastT], candidates: [...cs, ...others] });
      expect(out.filter((s) => /same dj/i.test(s.track.artist))).toHaveLength(2);
    });
    it('compliance-first still holds when enough compliant tracks from distinct artists exist', () => {
      const compliantSame = Array.from({ length: 4 }, (_, i) => t(`cs${i}`, { artist: 'Same DJ', ...good }));
      const compliantOthers = Array.from({ length: 8 }, (_, i) => t(`co${i}`, { bpm: 129, camelot: '8A', energy: 5 }));
      const off = Array.from({ length: 5 }, (_, i) => t(`x${i}`, { bpm: 90, camelot: '2B', energy: 9 }));
      const out = suggestNext({ ...base, playlist: [lastT], candidates: [...off, ...compliantSame, ...compliantOthers] });
      expect(out).toHaveLength(10);
      expect(out.every((s) => s.compliant)).toBe(true);
      const firstNon = out.findIndex((s) => !s.compliant);
      expect(firstNon).toBe(-1);
    });
    it('a compliant candidate never ranks below a non-compliant one after the cap', () => {
      const compliantSame = Array.from({ length: 4 }, (_, i) => t(`cs${i}`, { artist: 'Same DJ', ...good }));
      const off = Array.from({ length: 8 }, (_, i) => t(`x${i}`, { bpm: 90, camelot: '2B', energy: 9 }));
      const out = suggestNext({ ...base, playlist: [lastT], candidates: [...off, ...compliantSame] });
      expect(out.filter((s) => s.compliant)).toHaveLength(2);
      const flags = out.map((s) => Number(!!s.compliant));
      expect(flags).toEqual([...flags].sort((a, b) => b - a));
    });
  });
});
