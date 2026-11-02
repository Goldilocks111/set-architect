import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANES } from '@/lib/style/taxonomy';
import type { Suggestion } from '@/types/track';
import {
  buildRatingFile,
  auditCrate,
  isWarmEntry,
  warmStylesMode,
  KNOWN_CRATE_SHORTFALL,
  lowCrateScenarios,
  crateReadyThreshold,
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
      const short = KNOWN_CRATE_SHORTFALL[s.id];
      expect(new Set(s.crate!.map(k)).size, s.id).toBe(s.crate!.length);
      const inLane = s.crate!.filter((c) => lane.has(k(c))).length;
      // a lane the index cannot fill with grounded tracks is lowered, never padded with invented ones (documented)
      if (short) expect(s.crate!.length, s.id).toBeGreaterThanOrEqual(short.minCrate);
      else expect(s.crate, s.id).toHaveLength(40);
      expect(inLane, s.id).toBeGreaterThanOrEqual(short ? short.minInLane : 24);
      expect(s.crate!.length - inLane, s.id).toBeLessThanOrEqual(short ? short.maxOtherLane : 16);
      // in-lane stays a clear majority (other crates run ~0.58 other-lane per in-lane)
      expect((s.crate!.length - inLane) / inLane, s.id).toBeLessThanOrEqual(0.7);
    }
  });
  it('keeps the short disco-opener crate balanced: no techno/melodic-techno distractors, <= 10 other-lane', () => {
    const s = scenarios.find((x) => x.id === 'disco-opener')!;
    expect(KNOWN_CRATE_SHORTFALL['disco-opener'].maxOtherLane).toBeLessThanOrEqual(10);
    const other = (lane: string) => s.crate!.filter((c) => pools[lane].some((p) => k(p) === k(c))).length;
    expect(other('techno')).toBe(0);
    expect(other('melodic-techno')).toBe(0);
    // the short crate does not go PARTIAL just because it is short: 75% of it is enough
    expect(crateReadyThreshold(s.crate!.length)).toBeLessThanOrEqual(Math.ceil(0.75 * s.crate!.length));
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
  it('flags scenarios with fewer than 30 ready crate tracks (40-track crates)', () => {
    expect(MIN_CRATE_READY).toBe(30);
    expect(crateReadyThreshold(40)).toBe(30);
    expect(lowCrateScenarios([{ id: 'a', crateReady: 30, crateSize: 40 }, { id: 'b', crateReady: 29, crateSize: 40 }, { id: 'c', crateReady: 0, crateSize: 40 }])).toEqual(['b', 'c']);
  });
  it('scales the threshold for a short crate: min(30, ceil(0.75 x crate length))', () => {
    expect(crateReadyThreshold(24)).toBe(18);
    expect(crateReadyThreshold(25)).toBe(19);
    expect(lowCrateScenarios([{ id: 'ok', crateReady: 18, crateSize: 24 }])).toEqual([]);
    expect(lowCrateScenarios([{ id: 'low', crateReady: 17, crateSize: 24 }])).toEqual(['low']);
  });
  it('recsStatus is PARTIAL (naming the scenarios) when the crate was thin, even if everything else passed', () => {
    const base = { passed: 10, n: 10, stopped: [], refused: [], cooldowns: [] };
    expect(recsStatus({ ...base, lowCrate: [] })).toBe('PASS');
    expect(recsStatus({ ...base, lowCrate: ['b', 'c'] })).toMatch(/^PARTIAL.*crate.*b, c/);
    const msg = recsStatus({ ...base, lowCrate: ['b'] });
    expect(msg).toMatch(/min\(30, 75% of the crate\)/);
    expect(msg).not.toMatch(/demo-padded|under 30 ready/);
  });
  it('the bench never pads a crate with the demo starter crate (run.ts opts out)', () => {
    expect(readFileSync(join(__dirname, '../../bench/recs/run.ts'), 'utf8')).toMatch(/^\s*deps\.noStarterCrate = true;/m);
  });
});

describe('pool grounding', () => {
  const pools: Record<string, Array<{ artist: string; title: string; source: string }>> = JSON.parse(readFileSync(join(__dirname, '../../bench/recs/pools.json'), 'utf8'));
  const bench = new Set((JSON.parse(readFileSync(join(__dirname, '../../bench/search/tracks.json'), 'utf8')) as Array<{ artist: string; title: string }>).map((t) => `${t.artist}|${t.title}`));
  it('every pool entry has a source; no entry is from memory in the afro, progressive, melodic-techno and deep-house lanes', () => {
    for (const [lane, list] of Object.entries(pools)) for (const t of list) expect(['bench', '1001tl-index', 'memory'], `${lane} ${t.artist}`).toContain(t.source);
    for (const lane of ['afro-house', 'progressive-house', 'melodic-techno', 'deep-house']) {
      expect(pools[lane].filter((t) => t.source === 'memory').map((t) => `${t.artist} - ${t.title}`), lane).toEqual([]);
      expect(pools[lane].length, lane).toBeGreaterThanOrEqual(27);
    }
  });
  it("'bench' entries are really in bench/search/tracks.json", () => {
    for (const list of Object.values(pools)) for (const t of list.filter((x) => x.source === 'bench')) expect(bench.has(`${t.artist}|${t.title}`), t.title).toBe(true);
  });
});

describe('disco and pop hygiene, refills carry evidence', () => {
  const pools: Record<string, Array<{ artist: string; title: string; source: string; note?: string }>> = JSON.parse(readFileSync(join(__dirname, '../../bench/recs/pools.json'), 'utf8'));
  const has = (lane: string, re: RegExp) => pools[lane].some((t) => re.test(`${t.artist} ${t.title}`));
  it('keeps the round-3 removals out', () => {
    expect(has('disco-nu-disco', /Like A Prayer|Sussudio|Don't You Want Me|Sweet Dreams|Dancing On My Own|Padam Padam|Ruby Lee|To Be Invisible|Funk Like|Toop Toop|Sun Ra Was Right/)).toBe(false);
    expect(has('progressive-house', /Don't You Worry Child|Levels|Born Slippy/)).toBe(false);
    expect(has('techno', /Darkness Falls|Bassline/)).toBe(false);
    expect(has('afro-house', /Shout-N-Out|Affirmations|Step Closer/)).toBe(false);
  });
  it('keeps the round-4 mis-laned disco entries out of every pool (tech/bass, Latin tech, leftfield by their neighbours)', () => {
    for (const lane of Object.keys(pools)) expect(has(lane, /Kriss Reeve|Joy Marquez|Caribou/), lane).toBe(false);
  });
  it('keeps Sun Ra Was Right in the deep-house pool only', () => {
    expect(has('deep-house', /Sun Ra Was Right/)).toBe(true);
  });
  it('every refill (an entry with a note) names its neighbour evidence', () => {
    const noted = Object.values(pools).flat().filter((t) => t.note !== undefined);
    expect(noted.length).toBeGreaterThan(0);
    for (const t of noted) expect(t.note, t.title).toMatch(/adjacent .* in 1001TL sets/i);
  });
});

describe('auditCrate', () => {
  const c = (title: string, poolLane: boolean, styles?: string[]) => ({ artist: 'A', title, inLanePool: poolLane, styles });
  it('counts tag-confirmed in-lane tracks and lists pool-lane tracks whose styles contradict it', () => {
    const r = auditCrate('techno', [
      c('t1', true, ['techno', 'house']),
      c('t2', true, ['deep-house']),
      c('t3', true, undefined),
      c('t4', true, []),
      c('o1', false, ['techno']),
      c('o2', false, ['house']),
    ]);
    expect(r.tagConfirmed).toBe(2); // t1, and o1 (it carries the lane in its tags)
    expect(r.inLanePool).toBe(4);
    expect(r.untagged).toBe(2);
    expect(r.contradictions).toEqual([{ artist: 'A', title: 't2', styles: ['deep-house'] }]);
  });
});

describe('warmStylesMode', () => {
  it('counts styles only when a Last.fm key is set and tag lookups are not disabled', () => {
    expect(warmStylesMode({ hasKey: true, tagsDisabled: false })).toEqual({ countStyles: true });
  });
  it('counts essentials only, with the reason, when there is no key', () => {
    const m = warmStylesMode({ hasKey: false, tagsDisabled: false });
    expect(m.countStyles).toBe(false);
    expect(m.reason).toMatch(/LASTFM_API_KEY is not set/);
  });
  it('counts essentials only, with the reason, when Last.fm tags were disabled at runtime (key rejected)', () => {
    const m = warmStylesMode({ hasKey: true, tagsDisabled: true });
    expect(m.countStyles).toBe(false);
    expect(m.reason).toMatch(/disabled/i);
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
