import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANES } from '@/lib/style/taxonomy';
import type { Suggestion } from '@/types/track';
import {
  buildRatingFile,
  criterion3Holds,
  recsStatus,
  scoreScenario,
  seededShuffle,
  summarizeRecs,
  validateScenarios,
  type Scenario,
} from '../../bench/recs/score';

const scenarios: Scenario[] = JSON.parse(readFileSync(join(__dirname, '../../bench/recs/scenarios.json'), 'utf8'));
const tracks: Array<{ artist: string; title: string }> = JSON.parse(readFileSync(join(__dirname, '../../bench/search/tracks.json'), 'utf8'));

const sug = (i: number, o: { compliant?: boolean; reasons?: number; styles?: string[] } = {}): Suggestion => ({
  track: {
    id: `t${i}`, artist: `Artist ${i}`, title: `Title ${i}`, sources: {}, styles: o.styles,
    previewUrl: `https://cdn.example/p${i}.mp3`, youtubeUrl: `https://youtu.be/${i}`,
  },
  score: 0.9 - i / 100,
  reasons: Array.from({ length: o.reasons ?? 2 }, () => ({ kind: 'key' as const, label: 'Perfect match', score: 1 })),
  compliant: o.compliant ?? true,
});
const sc = (id = 's1'): Scenario => ({ id, name: `Scenario ${id}`, lane: 'techno', template: '60min', plannedLength: 10, set: [{ artist: 'A', title: 'B' }] });
const ten = (o: (i: number) => Parameters<typeof sug>[1] = () => ({})) => Array.from({ length: 10 }, (_, i) => sug(i, o(i)));

describe('scenarios.json', () => {
  it('has exactly 10 valid scenarios', () => {
    expect(scenarios).toHaveLength(10);
    expect(validateScenarios(scenarios)).toEqual([]);
    for (const s of scenarios) expect(LANES).toContain(s.lane);
  });
  it('gives each scenario a 40-track crate drawn from the bench list and a distinct id', () => {
    const known = new Set(tracks.map((t) => `${t.artist}|${t.title}`));
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(10);
    for (const s of scenarios) {
      expect(s.crate).toHaveLength(40);
      for (const c of s.crate!) expect(known.has(`${c.artist}|${c.title}`)).toBe(true);
    }
  });
  it('covers the cold start (1 track) and set sizes 1-6', () => {
    expect(scenarios.some((s) => s.set.length === 1)).toBe(true);
    for (const s of scenarios) expect(s.set.length).toBeGreaterThanOrEqual(1), expect(s.set.length).toBeLessThanOrEqual(6);
  });
  it('validateScenarios flags a bad lane, duplicate id and oversized set', () => {
    const bad = [{ ...sc('a'), lane: 'polka' }, sc('a'), { ...sc('b'), set: Array(7).fill({ artist: 'x', title: 'y' }) }] as Scenario[];
    expect(validateScenarios(bad).join('\n')).toMatch(/lane[\s\S]*duplicate[\s\S]*set/i);
  });
});

describe('scoreScenario / criterion 3', () => {
  it('counts compliant, reasons and lane hits in the top 10', () => {
    const r = scoreScenario(sc(), ten((i) => ({ compliant: i < 8, styles: i < 5 ? ['techno'] : ['house'] })));
    expect(r).toMatchObject({ n: 10, compliant: 8, reasonsOnAll: true, laneHits: 5, laneHitRate: 0.5 });
    expect(criterion3Holds(r)).toBe(true);
  });
  it('fails with 7 compliant, a missing reason, or fewer than 10 suggestions', () => {
    expect(criterion3Holds(scoreScenario(sc(), ten((i) => ({ compliant: i < 7 }))))).toBe(false);
    expect(criterion3Holds(scoreScenario(sc(), ten((i) => ({ reasons: i === 3 ? 0 : 2 }))))).toBe(false);
    expect(criterion3Holds(scoreScenario(sc(), ten().slice(0, 9)))).toBe(false);
  });
  it('treats a missing compliant flag as not compliant and only looks at the top 10', () => {
    const list = [...ten(), sug(10, { compliant: false })];
    expect(scoreScenario(sc(), list).n).toBe(10);
    const noFlag = ten(); delete noFlag[0].compliant;
    expect(scoreScenario(sc(), noFlag).compliant).toBe(9);
  });
});

describe('summary and status', () => {
  const rows = (pass: number) => Array.from({ length: 10 }, (_, i) => scoreScenario(sc(), ten((j) => ({ compliant: i < pass || j < 7 }))));
  it('counts passing scenarios', () => {
    expect(summarizeRecs(rows(10))).toMatchObject({ n: 10, passed: 10 });
    expect(summarizeRecs(rows(6))).toMatchObject({ n: 10, passed: 6 });
  });
  it('PASS only at 10/10 with no degrade; PARTIAL on any stop/refusal/cooldown', () => {
    const base = { passed: 10, n: 10, stopped: [], refused: [], cooldowns: [] };
    expect(recsStatus(base)).toBe('PASS');
    expect(recsStatus({ ...base, passed: 9 })).toBe('FAIL');
    expect(recsStatus({ ...base, stopped: ['lastfm'] })).toMatch(/^PARTIAL/);
    expect(recsStatus({ ...base, refused: ['spotify'] })).toMatch(/^PARTIAL/);
    expect(recsStatus({ ...base, cooldowns: ['deezer'] })).toMatch(/^PARTIAL/);
  });
});

describe('seededShuffle', () => {
  const xs = Array.from({ length: 10 }, (_, i) => i);
  it('is deterministic for a seed, a permutation, and does not mutate', () => {
    const a = seededShuffle(xs, 42);
    expect(seededShuffle(xs, 42)).toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual(xs);
    expect(xs).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(a).not.toEqual(xs);
    expect(seededShuffle(xs, 43)).not.toEqual(a);
  });
});

describe('buildRatingFile (blind)', () => {
  const results = [
    { scenario: { ...sc('s1'), crate: [{ artist: 'C', title: 'D' }] }, suggestions: ten((i) => ({ styles: ['techno'], compliant: i % 2 === 0 })) },
    { scenario: sc('s2'), suggestions: ten() },
  ];
  it('keeps only set + artist/title/previewUrl/youtubeUrl: no scores, reasons or compliant flags', () => {
    const file = buildRatingFile(results, 7);
    const text = JSON.stringify(file);
    for (const banned of ['score', 'reason', 'compliant', 'Perfect match', 'styles', 'crate', 'plannedLength']) expect(text).not.toContain(banned);
    expect(file.scenarios).toHaveLength(2);
    expect(Object.keys(file.scenarios[0].tracks[0]).sort()).toEqual(['artist', 'previewUrl', 'title', 'youtubeUrl']);
    expect(file.scenarios[0].tracks).toHaveLength(10);
    expect(file.scenarios[0].set).toEqual([{ artist: 'A', title: 'B' }]);
  });
  it('shuffles with a fixed seed: same seed same order, and not the engine rank order', () => {
    const order = (f: ReturnType<typeof buildRatingFile>) => f.scenarios[0].tracks.map((t) => t.title);
    expect(order(buildRatingFile(results, 7))).toEqual(order(buildRatingFile(results, 7)));
    expect(order(buildRatingFile(results, 7))).not.toEqual(results[0].suggestions.map((s) => s.track.title));
  });
});
