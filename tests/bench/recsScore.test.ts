import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANES } from '@/lib/style/taxonomy';
import { trackKeyOf, type Suggestion } from '@/types/track';
import {
  buildRatingFile,
  baselinePicks,
  summarizeRatings,
  auditCrate,
  isWarmEntry,
  warmStylesMode,
  crateFor,
  poolLimitedScenarios,
  sharedCrate,
  withCrates,
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
  it('carries no per-scenario crate: every scenario rates against the shared crate (union of all lane pools)', () => {
    for (const s of scenarios) expect(s.crate, s.id).toBeUndefined();
  });
  it('sharedCrate is every unique pool track (~225, a realistic DJ library), first spelling wins', () => {
    const shared = sharedCrate(pools);
    const keys = shared.map((t) => trackKeyOf(t.artist, t.title));
    expect(new Set(keys).size).toBe(keys.length);
    expect(shared.length).toBe(new Set(Object.values(pools).flat().map((t) => trackKeyOf(t.artist, t.title))).size);
    expect(shared.length).toBeGreaterThanOrEqual(200);
    expect(Object.keys(shared[0]).sort()).toEqual(['artist', 'title']);
  });
  it("crateFor leaves the scenario's own set tracks out; every lane is represented", () => {
    const shared = sharedCrate(pools);
    for (const s of withCrates(scenarios, pools)) {
      const crate = new Set(s.crate!.map((t) => trackKeyOf(t.artist, t.title)));
      for (const t of s.set) expect(crate.has(trackKeyOf(t.artist, t.title)), `${s.id} ${k(t)}`).toBe(false);
      expect(s.crate!.length, s.id).toBe(shared.length - s.set.filter((t) => shared.some((c) => trackKeyOf(c.artist, c.title) === trackKeyOf(t.artist, t.title))).length);
      for (const lane of Object.keys(pools)) expect(s.crate!.some((c) => pools[lane].some((p) => trackKeyOf(p.artist, p.title) === trackKeyOf(c.artist, c.title))), `${s.id} ${lane}`).toBe(true);
    }
    expect(crateFor({ set: [{ artist: 'X', title: 'Y' }] }, [{ artist: 'x', title: 'y (Original Mix)' }, { artist: 'Z', title: 'W' }])).toEqual([{ artist: 'Z', title: 'W' }]);
  });
  it('keeps the unique track count warm-able (<= 250)', () => {
    expect(uniqueScenarioTracks(withCrates(scenarios, pools)).length).toBeLessThanOrEqual(250);
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
  it('a pool-limited scenario (< 10 compliant candidates available) means the run cannot PASS, and is named', () => {
    expect(poolLimitedScenarios([{ id: 'a', compliantAvailable: 9 }, { id: 'b', compliantAvailable: 10 }, { id: 'c', compliantAvailable: 0 }])).toEqual(['a', 'c']);
    const base = { passed: 10, n: 10, stopped: [], refused: [], cooldowns: [] };
    expect(recsStatus({ ...base, poolLimited: [] })).toBe('PASS');
    expect(recsStatus({ ...base, poolLimited: ['a', 'c'] })).toMatch(/^POOL-LIMITED.*a, c/);
    expect(recsStatus({ ...base, passed: 7, poolLimited: ['a'] })).toMatch(/^POOL-LIMITED/);
    expect(recsStatus({ ...base, refused: ['spotify'], poolLimited: ['a'] })).toMatch(/^PARTIAL.*pool-limited: a/);
  });
  it('run.ts records compliantAvailable per row and prints the pool-limited scenarios', () => {
    const run = readFileSync(join(__dirname, '../../bench/recs/run.ts'), 'utf8');
    expect(run).toMatch(/compliantAvailable/);
    expect(run).toMatch(/poolLimitedScenarios\(rows\)/);
    expect(run).toMatch(/withCrates\(/);
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

describe('buildRatingFile (blind, engine vs baseline)', () => {
  const crate = Array.from({ length: 40 }, (_, i) => ({ artist: `Crate ${i}`, title: `C${i}`, bpm: 120 + (i % 20) }));
  const results = Array.from({ length: 10 }, (_, i) => ({
    scenario: { ...sc(`s${i}`), crate: crate.map(({ artist, title }) => ({ artist, title })) },
    suggestions: ten((j) => ({ styles: ['techno'], compliant: j % 2 === 0 })),
    crate,
    lastBpm: 124,
  }));
  it('two unlabelled lists of 10 per scenario; tracks carry artist/title only; nothing identifies the engine', () => {
    const { file } = buildRatingFile(results, { seed: 7, fileId: 'f1' });
    const text = JSON.stringify(file);
    for (const banned of ['score', 'reason', 'compliant', 'Perfect match', 'styles', 'crate', 'plannedLength', 'engine', 'baseline', 'previewUrl', 'youtubeUrl', 'bpm'])
      expect(text, banned).not.toContain(banned);
    expect(file).toMatchObject({ version: 2, fileId: 'f1' });
    expect(file.scenarios).toHaveLength(10);
    for (const s of file.scenarios) {
      expect(s.lists.map((l) => l.label)).toEqual(['A', 'B']);
      for (const l of s.lists) {
        expect(l.tracks).toHaveLength(10);
        for (const t of l.tracks) expect(Object.keys(t).sort()).toEqual(['artist', 'title']);
      }
    }
    expect(file.scenarios[0].set).toEqual([{ artist: 'A', title: 'B' }]);
  });
  it('the key (results file only) says which list is the engine; the engine list holds the top 10, shuffled', () => {
    const { file, key } = buildRatingFile(results, { seed: 7, fileId: 'f1' });
    for (const s of file.scenarios) {
      const label = key[s.id].engine;
      expect(['A', 'B']).toContain(label);
      expect(key[s.id].baseline).toBe(label === 'A' ? 'B' : 'A');
      const engine = s.lists.find((l) => l.label === label)!;
      expect(engine.tracks.map((t) => t.title).sort()).toEqual(ten().map((x) => x.track.title).sort());
      expect(engine.tracks.map((t) => t.title)).not.toEqual(ten().map((x) => x.track.title));
    }
  });
  it('deterministic per seed; the A/B order is randomized per scenario', () => {
    const a = buildRatingFile(results, { seed: 7, fileId: 'f1' });
    expect(buildRatingFile(results, { seed: 7, fileId: 'f1' })).toEqual(a);
    const labels = Object.values(a.key).map((k) => k.engine);
    expect(new Set(labels)).toEqual(new Set(['A', 'B']));
    expect(buildRatingFile(results, { seed: 8, fileId: 'f1' }).file).not.toEqual(a.file);
  });
});

describe('baselinePicks', () => {
  const crate = Array.from({ length: 60 }, (_, i) => ({ artist: `Crate ${i}`, title: `C${i}`, bpm: 100 + i }));
  const engine = crate.filter((c) => c.bpm >= 120 && c.bpm <= 123).map(({ artist, title }) => ({ artist, title }));
  it('10 seeded random crate tracks within ±6% BPM of the last set track, excluding engine picks', () => {
    const picks = baselinePicks({ crate, lastBpm: 125, engine, seed: 3 });
    expect(picks).toHaveLength(10);
    expect(baselinePicks({ crate, lastBpm: 125, engine, seed: 3 })).toEqual(picks);
    expect(baselinePicks({ crate, lastBpm: 125, engine, seed: 4 })).not.toEqual(picks);
    const engineKeys = new Set(engine.map((t) => t.title));
    for (const p of picks) {
      const bpm = crate.find((c) => c.title === p.title)!.bpm;
      expect(Math.abs(bpm - 125) / 125).toBeLessThanOrEqual(0.06);
      expect(engineKeys.has(p.title)).toBe(false);
    }
  });
  it('uses engine picks only when the tempo-matched crate runs short, then the nearest-tempo rest', () => {
    const small = crate.slice(18, 27); // bpm 118..126: 9 tracks, all within 6% of 122
    const eng = [{ artist: 'Crate 20', title: 'C20' }];
    const picks = baselinePicks({ crate: [...small, ...crate.slice(0, 3)], lastBpm: 122, engine: eng, seed: 1 });
    expect(picks).toHaveLength(10);
    expect(picks.map((p) => p.title)).toContain('C20'); // only 8 non-engine matches, so the engine pick is reused
    expect(picks.filter((p) => ['C0', 'C1', 'C2'].includes(p.title))).toHaveLength(1);
    expect(picks.map((p) => p.title)).toContain('C2'); // nearest tempo (102) of the out-of-range rest
  });
  it('without a last-track BPM it draws from the whole crate', () => {
    expect(baselinePicks({ crate, lastBpm: undefined, engine: [], seed: 1 })).toHaveLength(10);
  });
});

describe('summarizeRatings (acceptance; never shown during rating)', () => {
  const key = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}`, i % 2 ? { engine: 'A' as const, baseline: 'B' as const } : { engine: 'B' as const, baseline: 'A' as const }]));
  const exp = (f: (i: number) => { engine?: number; baseline?: number }) => ({
    fileId: 'f1',
    ratings: Array.from({ length: 10 }, (_, i) => {
      const r = f(i);
      const k = key[`s${i}`];
      return { id: `s${i}`, [k.engine]: r.engine ?? null, [k.baseline]: r.baseline ?? null };
    }),
  });
  it('passes at engine >= 7 on >= 8 scenarios AND engine > baseline on >= 7', () => {
    const r = summarizeRatings(exp((i) => ({ engine: i < 8 ? 8 : 5, baseline: i < 7 ? 6 : 9 })), key);
    expect(r).toMatchObject({ total: 10, engineGood: 8, engineBeatsBaseline: 7, pass: true });
  });
  it('fails when the engine does not beat the baseline often enough, even with high ratings', () => {
    const r = summarizeRatings(exp((i) => ({ engine: 9, baseline: i < 6 ? 8 : 9 })), key);
    expect(r).toMatchObject({ engineGood: 10, engineBeatsBaseline: 6, pass: false });
  });
  it('fails at 7 good; unrated counts as neither good nor beating', () => {
    expect(summarizeRatings(exp((i) => ({ engine: i < 7 ? 8 : 6, baseline: 1 })), key)).toMatchObject({ engineGood: 7, pass: false });
    expect(summarizeRatings(exp((i) => (i < 9 ? { engine: 9, baseline: 1 } : {})), key)).toMatchObject({ engineGood: 9, engineBeatsBaseline: 9, rated: 9, pass: true });
    expect(summarizeRatings(exp(() => ({ engine: 9 })), key)).toMatchObject({ engineBeatsBaseline: 0, pass: false });
  });
  it('maps A/B through the key: swapping the key swaps the verdict', () => {
    const e = exp((i) => ({ engine: 9, baseline: 2 + (i % 2) }));
    const swapped = Object.fromEntries(Object.entries(key).map(([id, k]) => [id, { engine: k.baseline, baseline: k.engine }]));
    expect(summarizeRatings(e, key).pass).toBe(true);
    expect(summarizeRatings(e, swapped).pass).toBe(false);
  });
});

describe('crate readiness', () => {
  it('flags scenarios with fewer than 30 ready crate tracks (the shared ~225 crate)', () => {
    expect(MIN_CRATE_READY).toBe(30);
    expect(crateReadyThreshold(40)).toBe(30);
    expect(crateReadyThreshold(222)).toBe(30);
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
    const pools = JSON.parse(readFileSync(join(__dirname, '../../bench/recs/pools.json'), 'utf8'));
    const u = uniqueScenarioTracks(withCrates(scenarios, pools));
    const keys = u.map((t) => `${t.artist}|${t.title}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(u.length).toBeLessThan(withCrates(scenarios, pools).reduce((n, s) => n + s.set.length + (s.crate?.length ?? 0), 0));
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
