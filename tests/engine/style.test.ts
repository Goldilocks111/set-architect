import { describe, expect, it } from 'vitest';
import { laneProfile, styleScore } from '@/engine/style';
import type { Track } from '@/types/track';

let n = 0;
const t = (styles?: string[], o: Partial<Track> = {}): Track => ({
  id: `t${n++}`,
  artist: 'A',
  title: `T${n}`,
  sources: {},
  bpm: 124,
  camelot: '8A',
  energy: 5,
  danceability: 0.6,
  ...(styles ? { styles } : {}),
  ...o,
});

describe('laneProfile', () => {
  it('weights the last 5 complete tracks by recency (1 .8 .6 .4 .2) and lanes by rank (1 .6 .3)', () => {
    const p = laneProfile([t(['house']), t(['techno', 'minimal', 'electro'])]);
    expect(p.get('techno')).toBeCloseTo(1);
    expect(p.get('minimal')).toBeCloseTo(0.6);
    expect(p.get('electro')).toBeCloseTo(0.3);
    expect(p.get('house')).toBeCloseTo(0.8);
  });

  it('only the last 5 complete tracks count; incomplete ones are skipped', () => {
    const old = t(['trance']);
    const incomplete = t(['drum-and-bass'], { bpm: undefined });
    const p = laneProfile([old, ...Array.from({ length: 5 }, () => t(['techno'])), incomplete]);
    expect(p.has('trance')).toBe(false);
    expect(p.has('drum-and-bass')).toBe(false);
    expect(p.get('techno')).toBeCloseTo(1 + 0.8 + 0.6 + 0.4 + 0.2);
  });

  it('ignores labels that are not lanes', () => {
    expect(laneProfile([t(['not-a-lane'])]).size).toBe(0);
  });
});

describe('styleScore', () => {
  it('unknown style is neutral: undefined when either side has no lanes', () => {
    expect(styleScore(new Map(), t(['techno']))).toBeUndefined();
    expect(styleScore(laneProfile([t(['techno'])]), t())).toBeUndefined();
    expect(styleScore(laneProfile([t(['techno'])]), t([]))).toBeUndefined();
  });

  it('cosine similarity in 0..1', () => {
    const p = laneProfile([t(['melodic-techno'])]);
    expect(styleScore(p, t(['melodic-techno']))!.score).toBeCloseTo(1);
    expect(styleScore(p, t(['drum-and-bass']))!.score).toBe(0);
    const mid = styleScore(p, t(['techno', 'melodic-techno']))!.score;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('labels "Same lane: <lane>" at ≥ 0.6 and "Lane change" at ≤ 0.2', () => {
    const p = laneProfile([t(['melodic-techno'])]);
    expect(styleScore(p, t(['melodic-techno']))!.label).toBe('Same lane: melodic techno');
    expect(styleScore(p, t(['drum-and-bass']))!.label).toBe('Lane change');
  });

  it('lane follows recency: a set that moved melodic → techno favors techno', () => {
    const set = [...Array.from({ length: 6 }, () => t(['melodic-techno'])), ...Array.from({ length: 3 }, () => t(['techno']))];
    const p = laneProfile(set);
    const techno = styleScore(p, t(['techno']))!;
    const melodic = styleScore(p, t(['melodic-techno']))!;
    expect(techno.score).toBeGreaterThan(melodic.score);
    expect(techno.label).toBe('Same lane: techno');
  });
});
