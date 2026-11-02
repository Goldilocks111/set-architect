import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANES } from '@/lib/style/taxonomy';
import type { Suggestion } from '@/types/track';
import {
  buildRatingFile,
  isWarmEntry,
  lowCrateScenarios,
  MIN_CRATE_READY,
  selectWarmTargets,
  uniqueScenarioTracks,
  criterion3Holds,
  recsStatus,
  scoreScenario,
  seededShuffle,
  summarizeRecs,
  validateScenarios,
  type Scenario,
} from '../../bench/recs/score';

const scenarios: Scenario[] = JSON.parse(readFileSync(join(__dirname, '../../bench/recs/scenarios.json'), 'utf8'));

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
  const pools: Record<string, Array<{ artist: string; title: string }>> = JSON.parse(readFileSync(join(__dirname, '../../bench/recs/pools.json'), 'utf8'));
  const k = (t: { artist: string; title: string }) => `${t.artist}|${t.title}`;
  it('gives each scenario a 40-track crate: >= 24 in its lane, <= 16 from other lanes', () => {
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(10);
    for (const s of scenarios) {
      const lane = new Set((pools[s.lane] ?? []).map(k));
      expect(s.crate, s.id).toHaveLength(40);
      expect(new Set(s.crate!.map(k)).size, s.id).toBe(40);
      const inLane = s.crate!.filter((c) => lane.has(k(c))).length;
      expect(inLane, s.id).toBeGreaterThanOrEqual(24);
      expect(40 - inLane, s.id).toBeLessThanOrEqual(16);
    }
  });
  it('keeps the unique track count warm-able (<= 250) and set tracks out of the crate', () => {
    expect(uniqueScenarioTracks(scenarios).length).toBeLessThanOrEqual(250);
    for (const s of scenarios) {
      const crate = new Set(s.crate!.map(k));
      for (const t of s.set) expect(crate.has(k(t)), `${s.id} ${k(t)}`).toBe(false);
    }
  });
  it('uses in-lane set tracks (the lane change and the incomplete-track probe are exempt)', () => {
    for (const s of scenarios.filter((x) => !['lane-change', 'incomplete-track'].includes(x.id))) {
      const lane = new Set(pools[s.lane].map(k));
      for (const t of s.set) expect(lane.has(k(t)), `${s.id} ${k(t)}`).toBe(true);
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

describe('crate readiness', () => {
  it('flags scenarios with fewer than 30 ready crate tracks', () => {
    expect(MIN_CRATE_READY).toBe(30);
    expect(lowCrateScenarios([{ id: 'a', crateReady: 30 }, { id: 'b', crateReady: 29 }, { id: 'c', crateReady: 0 }])).toEqual(['b', 'c']);
  });
  it('recsStatus is PARTIAL (naming the scenarios) when the crate was thin, even if everything else passed', () => {
    const base = { passed: 10, n: 10, stopped: [], refused: [], cooldowns: [] };
    expect(recsStatus({ ...base, lowCrate: [] })).toBe('PASS');
    expect(recsStatus({ ...base, lowCrate: ['b', 'c'] })).toMatch(/^PARTIAL.*crate.*b, c/);
  });
});

describe('pool grounding', () => {
  const pools: Record<string, Array<{ artist: string; title: string; source: string }>> = JSON.parse(readFileSync(join(__dirname, '../../bench/recs/pools.json'), 'utf8'));
  const bench = new Set((JSON.parse(readFileSync(join(__dirname, '../../bench/search/tracks.json'), 'utf8')) as Array<{ artist: string; title: string }>).map((t) => `${t.artist}|${t.title}`));
  it('every pool entry has a source; no entry is from memory in the afro, progressive, melodic-techno and deep-house lanes', () => {
    for (const [lane, list] of Object.entries(pools)) for (const t of list) expect(['bench', '1001tl-index', 'memory'], `${lane} ${t.artist}`).toContain(t.source);
    for (const lane of ['afro-house', 'progressive-house', 'melodic-techno', 'deep-house']) {
      expect(pools[lane].filter((t) => t.source === 'memory').map((t) => `${t.artist} - ${t.title}`), lane).toEqual([]);
      expect(pools[lane].length, lane).toBeGreaterThanOrEqual(28);
    }
  });
  it("'bench' entries are really in bench/search/tracks.json", () => {
    for (const list of Object.values(pools)) for (const t of list.filter((x) => x.source === 'bench')) expect(bench.has(`${t.artist}|${t.title}`), t.title).toBe(true);
  });
});

describe('isWarmEntry', () => {
  const deps = { isComplete: (f: any) => f.complete === true, stylesSettled: (e: any) => e.settled === true };
  it('needs a cache entry with complete essentials AND settled styles', () => {
    expect(isWarmEntry(undefined, deps)).toBe(false);
    expect(isWarmEntry({ fields: { complete: false }, settled: true }, deps)).toBe(false);
    expect(isWarmEntry({ fields: { complete: true }, settled: false }, deps)).toBe(false); // re-queued on the next warm run
    expect(isWarmEntry({ fields: { complete: true }, settled: true }, deps)).toBe(true);
  });
});

describe('warm mode selection', () => {
  it('dedupes set + crate tracks across scenarios by track key', () => {
    const u = uniqueScenarioTracks(scenarios);
    const keys = u.map((t) => `${t.artist}|${t.title}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(u.length).toBeLessThan(scenarios.reduce((n, s) => n + s.set.length + (s.crate?.length ?? 0), 0));
    for (const s of scenarios) for (const t of s.set) expect(keys).toContain(`${t.artist}|${t.title}`);
  });
  it('skips tracks the cache already holds complete, so a warm run is resumable', () => {
    const refs = [{ artist: 'A', title: 'one' }, { artist: 'B', title: 'two' }, { artist: 'C', title: 'three' }];
    const done = new Set(['b|two']);
    const { todo, complete } = selectWarmTargets(refs, (r) => done.has(`${r.artist.toLowerCase()}|${r.title}`));
    expect(todo.map((t) => t.title)).toEqual(['one', 'three']);
    expect(complete).toBe(1);
  });
});
