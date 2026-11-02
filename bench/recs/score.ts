import { LANES } from '../../src/lib/style/taxonomy';
import { scoreBpmTransition } from '../../src/engine/bpm';
import { trackKeyOf, type ArcTemplate, type Suggestion } from '../../src/types/track';

export interface TrackRef {
  artist: string;
  title: string;
}

export interface Scenario {
  id: string;
  name: string;
  lane: string;
  template: ArcTemplate;
  plannedLength: number;
  set: TrackRef[];
  /** Filled at run time by withCrates (the shared crate minus this set); scenarios.json carries none. */
  crate?: TrackRef[];
}

export const TOP_N = 10;
/** Criterion 3: at least this many of the top 10 are compliant. */
export const MIN_COMPLIANT = 8;
/** Ready crate tracks the shared crate needs; the bench never demo-pads (deps.noStarterCrate). */
export const MIN_CRATE_READY = 30;

/** Hard per-provider request budgets (daily counts shared with the other benches). YouTube is never automatic: 0. */
export const RECS_BUDGET: Record<string, number> = { spotify: 60, deezer: 300, lastfm: 400, musicbrainz: 200, reccobeats: 200, youtube: 0 };
/** Adapters every bench resolve leaves out: iTunes IP-blocks us; YouTube search.list spends a shared quota. */
export const BENCH_WITHOUT = ['itunes', 'youtube'];

export function validateScenarios(list: Scenario[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    if (seen.has(s.id)) errors.push(`${s.id}: duplicate id`);
    seen.add(s.id);
    if (!(LANES as readonly string[]).includes(s.lane)) errors.push(`${s.id}: lane "${s.lane}" is not in LANES`);
    if (s.set.length < 1 || s.set.length > 6) errors.push(`${s.id}: set has ${s.set.length} tracks (1-6)`);
  }
  return errors;
}

export interface ScenarioScore {
  n: number;
  compliant: number;
  reasonsOnAll: boolean;
  laneHits: number;
  laneHitRate: number;
}

export function scoreScenario(sc: Pick<Scenario, 'lane'>, suggestions: Suggestion[]): ScenarioScore {
  const top = suggestions.slice(0, TOP_N);
  const laneHits = top.filter((s) => s.track.styles?.includes(sc.lane)).length;
  return {
    n: top.length,
    compliant: top.filter((s) => s.compliant === true).length,
    reasonsOnAll: top.length > 0 && top.every((s) => s.reasons.length > 0),
    laneHits,
    laneHitRate: top.length ? laneHits / top.length : 0,
  };
}

export const criterion3Holds = (r: ScenarioScore): boolean => r.n === TOP_N && r.compliant >= MIN_COMPLIANT && r.reasonsOnAll;

export function summarizeRecs(rows: ScenarioScore[]): { n: number; passed: number; meanLaneHitRate: number } {
  return {
    n: rows.length,
    passed: rows.filter(criterion3Holds).length,
    meanLaneHitRate: rows.length ? rows.reduce((a, r) => a + r.laneHitRate, 0) / rows.length : 0,
  };
}

/**
 * PARTIAL on any provider degrade: a run that lost a provider says nothing about recommendation quality.
 * POOL-LIMITED when some scenario had fewer than TOP_N compliant candidates at all: criterion 3 there measures the
 * pool, not the engine, so the run cannot PASS.
 */
export function recsStatus(o: {
  passed: number;
  n: number;
  stopped: string[];
  refused: string[];
  cooldowns: string[];
  lowCrate?: string[];
  poolLimited?: string[];
}): string {
  const parts: string[] = [];
  if (o.lowCrate?.length) parts.push(`crate below its ready threshold, min(${MIN_CRATE_READY}, 75% of the crate) (thin pool; the bench never adds demo tracks): ${o.lowCrate.join(', ')}`);
  if (o.stopped.length) parts.push(`rate-limited: ${o.stopped.join(', ')}`);
  if (o.refused.length) parts.push(`budget exhausted: ${o.refused.join(', ')}`);
  if (o.cooldowns.length) parts.push(`breaker cooldown: ${o.cooldowns.join(', ')}`);
  const limited = o.poolLimited?.length ? `pool-limited: ${o.poolLimited.join(', ')}` : '';
  if (parts.length) return `PARTIAL (${[...parts, ...(limited ? [limited] : [])].join('; ')})`;
  if (limited) return `POOL-LIMITED (criterion 3 holds on ${o.passed}/${o.n}; ${limited})`;
  return o.passed === o.n ? 'PASS' : 'FAIL';
}

/** Scenarios whose pool held fewer than TOP_N compliant candidates (after exclusions): the engine could not reach 10. */
export function poolLimitedScenarios(rows: Array<{ id: string; compliantAvailable: number }>): string[] {
  return rows.filter((r) => r.compliantAvailable < TOP_N).map((r) => r.id);
}

/**
 * The bench crate: every unique track of every lane pool (~225, a realistic DJ library), first spelling wins.
 * Lane fit has to find the scenario's lane in it; the crate is not curated per scenario.
 */
export function sharedCrate(pools: Record<string, TrackRef[]>): TrackRef[] {
  const seen = new Map<string, TrackRef>();
  for (const list of Object.values(pools)) for (const { artist, title } of list) {
    const k = trackKeyOf(artist, title);
    if (!seen.has(k)) seen.set(k, { artist, title });
  }
  return [...seen.values()];
}

/** A scenario's crate: the shared crate without its own set tracks. */
export function crateFor(scenario: Pick<Scenario, 'set'>, shared: TrackRef[]): TrackRef[] {
  const inSet = new Set(scenario.set.map((t) => trackKeyOf(t.artist, t.title)));
  return shared.filter((t) => !inSet.has(trackKeyOf(t.artist, t.title)));
}

export function withCrates(scenarios: Scenario[], pools: Record<string, TrackRef[]>): Scenario[] {
  const shared = sharedCrate(pools);
  return scenarios.map((s) => ({ ...s, crate: crateFor(s, shared) }));
}

/** mulberry32: small, deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy; the same seed always gives the same order. */
export function seededShuffle<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  const rand = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface RatingList {
  label: 'A' | 'B';
  /** Artist/title only: previews are found on demand in /rate, so no list stands out by carrying them. */
  tracks: TrackRef[];
}

/** What the owner rates. Version 2: two unlabelled lists per scenario, engine and baseline in a seeded random order. */
export interface RatingFile {
  version: 2;
  fileId: string;
  scenarios: Array<{ id: string; name: string; template: ArcTemplate; set: TrackRef[]; lists: RatingList[] }>;
}

/** Which list is which, per scenario id: written to the results file only, never to the rating file. */
export type RatingKey = Record<string, { engine: 'A' | 'B'; baseline: 'A' | 'B' }>;

/** Baseline tracks are drawn from the crate within this tempo distance of the last set track. */
export const BASELINE_BPM_TOLERANCE = 0.06;

/** One display spelling for every name in the rating file: trimmed, inner whitespace collapsed, casing kept. */
export const normalizeName = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** In tempo as the engine sees it: direct within ±6%, or half/double-time (engine/bpm.ts relation). */
export const inTempo = (last: number | undefined, bpm: number | undefined): boolean =>
  last === undefined || (bpm !== undefined && (scoreBpmTransition(last, bpm).relation !== 'clash' || Math.abs(bpm - last) / last <= BASELINE_BPM_TOLERANCE));

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** The key-derived spelling (normalized key parts, title-cased, no punctuation), identical for every track it renders. */
export function formatFromKey(key: string): TrackRef {
  const [artist = '', title = ''] = key.split('|');
  return { artist: titleCase(artist), title: titleCase(title) };
}

export type CrateRef = TrackRef & { bpm?: number; styles?: string[] };

/**
 * The control list: what a DJ does by hand. Seeded random crate tracks that are in the scenario lane (the lane's pool
 * OR cached styles containing the lane) and within ±6% BPM of the last set track, engine picks left out while enough
 * others exist. Short of TOP_N, it fills from the same lane at any tempo (nearest first), then reuses engine picks;
 * it never leaves the lane. `short` counts the places the lane could not fill. No last BPM: the lane at any tempo.
 */
export function baselinePicks(o: { crate: CrateRef[]; lane: string; lanePool: ReadonlySet<string>; lastBpm?: number; engine: TrackRef[]; seed: number }): { picks: TrackRef[]; short: number; offTempo: number } {
  const key = (t: TrackRef) => trackKeyOf(t.artist, t.title);
  const engine = new Set(o.engine.map(key));
  const last = o.lastBpm;
  const near = (b?: number) => inTempo(last, b);
  const lane = o.crate.filter((t) => o.lanePool.has(key(t)) || t.styles?.includes(o.lane));
  const nearest = (xs: CrateRef[]) => [...xs].sort((a, b) => Math.abs((a.bpm ?? Infinity) - last!) - Math.abs((b.bpm ?? Infinity) - last!));
  const fresh = lane.filter((t) => !engine.has(key(t)));
  const reused = lane.filter((t) => engine.has(key(t)));
  const tiers = [
    seededShuffle(fresh.filter((t) => near(t.bpm)), o.seed),
    seededShuffle(reused.filter((t) => near(t.bpm)), o.seed + 1), // an in-tempo engine pick beats an off-tempo fresh one
    nearest(fresh.filter((t) => !near(t.bpm))),
    nearest(reused.filter((t) => !near(t.bpm))),
  ];
  const seen = new Set<string>();
  const picks: TrackRef[] = [];
  let offTempo = 0;
  for (const t of tiers.flat()) {
    if (picks.length >= TOP_N || seen.has(key(t))) continue;
    seen.add(key(t));
    if (!near(t.bpm)) offTempo++;
    picks.push({ artist: t.artist, title: t.title });
  }
  return { picks, short: TOP_N - picks.length, offTempo };
}

/** Off-tempo tracks the baseline may keep before both lists are trimmed further. */
export const MAX_OFF_TEMPO = 2;

/** Where a scenario's names came from: the provider's display names (every shown track has one), else one key-derived formatter for all. */
export type NamingMode = 'provider' | 'pool';

/** `<day>-<HHMMss>-<rand4>`: unique per measured run; names the rating file and namespaces its A/B key. */
export function makeRunId(day: string, now: Date, rand: () => number = Math.random): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const r = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0').slice(-4);
  return `${day}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${r}`;
}

/** FNV-1a of the run id: the shuffle/A-B seed, so no two runs share a key. */
export function seedFromRunId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Only a full measured run produces a rating file and key: a `--limit` smoke run must not leak or overwrite one. */
export const writesRating = (limit?: number): boolean => limit === undefined;

/**
 * The blind file and its key. Per scenario: the engine's top 10 and the baseline, each shuffled, presented as
 * List A / List B in a seeded random order. The file holds artist/title only; the key goes to the results file.
 * Names on both lists go through `display` (cache display name, then pool entry) and `normalizeName`, so no spelling
 * convention tells the lists apart. When the lane cannot fill the baseline, both lists are trimmed to the same
 * length and the trim is returned in `short`.
 */
export function buildRatingFile(
  results: Array<{ scenario: Scenario; suggestions: Suggestion[]; crate: CrateRef[]; lastBpm?: number }>,
  opts: { seed?: number; fileId: string; lanePool: (lane: string) => ReadonlySet<string>; provider?: (t: TrackRef) => TrackRef | undefined },
): { file: RatingFile; key: RatingKey; short: Array<{ id: string; engine: number; baseline: number; offTempo: number; used: number }>; offTempo: Record<string, number>; naming: Record<string, NamingMode> } {
  const seed = opts.seed ?? seedFromRunId(opts.fileId);
  const key: RatingKey = {};
  const short: Array<{ id: string; engine: number; baseline: number; offTempo: number; used: number }> = [];
  const offTempoBy: Record<string, number> = {};
  const naming: Record<string, NamingMode> = {};
  const clean = (d: TrackRef): TrackRef => ({ artist: normalizeName(d.artist), title: normalizeName(d.title) });
  const scenarios = results.map(({ scenario, suggestions, crate, lastBpm }, i) => {
    const s = seed + i * 7919;
    const engineAll = suggestions.slice(0, TOP_N).map(({ track: t }) => ({ artist: t.artist, title: t.title }));
    const drawn = baselinePicks({ crate, lane: scenario.lane, lanePool: opts.lanePool(scenario.lane), lastBpm, engine: engineAll, seed: s + 1 });
    offTempoBy[scenario.id] = drawn.offTempo;
    // an off-tempo baseline track is an audible free win for the engine: keep at most MAX_OFF_TEMPO of them
    const bpmOf = new Map(crate.map((c) => [trackKeyOf(c.artist, c.title), c.bpm] as const));
    const onTempo = drawn.picks.filter((p) => inTempo(lastBpm, bpmOf.get(trackKeyOf(p.artist, p.title))));
    const baselineAll = [...onTempo, ...drawn.picks.filter((p) => !onTempo.includes(p)).slice(0, MAX_OFF_TEMPO)];
    const used = Math.min(engineAll.length, baselineAll.length);
    if (used < TOP_N) short.push({ id: scenario.id, engine: engineAll.length, baseline: drawn.picks.length, offTempo: drawn.offTempo, used });
    // One rule per scenario: provider display names only when EVERY shown track (set + both lists) has one; otherwise
    // every track (set, engine externals, baseline) goes through the one key formatter, so spelling cannot tell the lists apart.
    const shown = [...scenario.set, ...engineAll.slice(0, used), ...baselineAll.slice(0, used)];
    const mode: NamingMode = opts.provider && shown.every((t) => opts.provider!(t)) ? 'provider' : 'pool';
    naming[scenario.id] = mode;
    const name = (t: TrackRef): TrackRef => clean(mode === 'provider' ? opts.provider!(t)! : formatFromKey(trackKeyOf(t.artist, t.title)));
    const engine = engineAll.slice(0, used).map(name);
    const baseline = baselineAll.slice(0, used).map(name);
    const engineFirst = rng(s + 2)() < 0.5;
    key[scenario.id] = engineFirst ? { engine: 'A', baseline: 'B' } : { engine: 'B', baseline: 'A' };
    const [a, b] = engineFirst ? [engine, baseline] : [baseline, engine];
    return {
      id: scenario.id,
      name: scenario.name,
      template: scenario.template,
      set: scenario.set.map(name),
      lists: [
        { label: 'A' as const, tracks: seededShuffle(a, s + 3) },
        { label: 'B' as const, tracks: seededShuffle(b, s + 4) },
      ],
    };
  });
  return { file: { version: 2, fileId: opts.fileId, scenarios }, key, short, offTempo: offTempoBy, naming };
}

/** Acceptance: the engine list rated >= 7 on >= 8 scenarios AND rated above the baseline on >= 7. */
export const RATING_PASS = 7;
export const RATING_MIN_GOOD = 8;
export const RATING_MIN_BEATS = 7;

/** The /rate export, as far as scoring needs it: per scenario, the rating of List A and of List B. */
export interface RatingExport {
  fileId?: string;
  ratings: Array<{ id: string; A?: number | null; B?: number | null }>;
}

/** Scores an export through the key (never shown during rating). Unrated counts as neither good nor beating. */
export function summarizeRatings(exp: RatingExport, key: RatingKey) {
  const rows = exp.ratings
    .filter((r) => key[r.id])
    .map((r) => {
      const k = key[r.id];
      const engine = r[k.engine] ?? undefined;
      const baseline = r[k.baseline] ?? undefined;
      return { id: r.id, engine, baseline };
    });
  const engineGood = rows.filter((r) => (r.engine ?? 0) >= RATING_PASS).length;
  const engineBeatsBaseline = rows.filter((r) => r.engine !== undefined && r.baseline !== undefined && r.engine > r.baseline).length;
  return {
    total: Object.keys(key).length,
    rated: rows.filter((r) => r.engine !== undefined).length,
    engineGood,
    engineBeatsBaseline,
    pass: engineGood >= RATING_MIN_GOOD && engineBeatsBaseline >= RATING_MIN_BEATS,
    rows,
  };
}

/** Ready crate tracks a scenario needs: MIN_CRATE_READY, or 75% of a crate shorter than 40. */
export const crateReadyThreshold = (crateSize: number): number => Math.min(MIN_CRATE_READY, Math.ceil(0.75 * crateSize));

export function lowCrateScenarios(rows: Array<{ id: string; crateReady: number; crateSize: number }>): string[] {
  return rows.filter((r) => r.crateReady < crateReadyThreshold(r.crateSize)).map((r) => r.id);
}

/** Every distinct set + crate track across the scenarios (by normalized track key), first spelling wins. */
export function uniqueScenarioTracks(list: Scenario[]): TrackRef[] {
  const seen = new Map<string, TrackRef>();
  for (const s of list) for (const t of [...s.set, ...(s.crate ?? [])]) {
    const k = trackKeyOf(t.artist, t.title);
    if (!seen.has(k)) seen.set(k, { artist: t.artist, title: t.title });
  }
  return [...seen.values()];
}

/** Warm mode resolves only what the cache does not already hold complete (resumable across days). */
export function selectWarmTargets(refs: TrackRef[], isCompleteInCache: (r: TrackRef) => boolean): { todo: TrackRef[]; complete: number } {
  const todo = refs.filter((r) => !isCompleteInCache(r));
  return { todo, complete: refs.length - todo.length };
}

/** Providers warm mode cannot do without: Deezer and MusicBrainz complete tracks keyless (with AcousticBrainz and preview analysis). */
export const WARM_ESSENTIAL_PROVIDERS = ['deezer', 'musicbrainz'];
/** Guard provider names that are also resolver adapters, so a spent one can be skipped via `without`. */
const SKIPPABLE_ADAPTERS = new Set(['spotify', 'reccobeats']);

/**
 * Warm mode after each resolve: stop only when Deezer or MusicBrainz is refused or rate-limited. A spent Spotify (or
 * ReccoBeats) budget just leaves that adapter out from then on (losing spotifyId -> ReccoBeats values); a spent
 * Last.fm only means styles stop settling.
 */
export function warmStep(o: { stopped: string[]; refused: string[] }): { stop: boolean; without: string[] } {
  const out = new Set([...o.stopped, ...o.refused]);
  return {
    stop: WARM_ESSENTIAL_PROVIDERS.some((p) => out.has(p)),
    without: [...BENCH_WITHOUT, ...[...out].filter((p) => SKIPPABLE_ADAPTERS.has(p) && !BENCH_WITHOUT.includes(p))],
  };
}

/** Whether warm mode can count styles; when it cannot, it counts essentials only and says why (lane fit will be blind). */
export function warmStylesMode(o: { hasKey: boolean; tagsDisabled: boolean }): { countStyles: boolean; reason?: string } {
  if (!o.hasKey) return { countStyles: false, reason: 'LASTFM_API_KEY is not set, so styles can never settle' };
  if (o.tagsDisabled) return { countStyles: false, reason: 'Last.fm tag lookups were disabled at runtime (key rejected), so styles cannot settle' };
  return { countStyles: true };
}

/** A cache entry is warm when its essentials are complete AND its styles lookup has settled (styles found, or a fresh "none" marker). */
export function isWarmEntry<E extends { fields: unknown }>(
  entry: E | undefined,
  deps: { isComplete: (fields: any) => boolean; stylesSettled: (e: E) => boolean },
): boolean {
  return !!entry && deps.isComplete(entry.fields) && deps.stylesSettled(entry);
}

export interface AuditCrateTrack {
  artist: string;
  title: string;
  /** The track is in the scenario lane's pool (pools.json). */
  inLanePool: boolean;
  /** Cached Last.fm-derived lanes, when known. */
  styles?: string[];
}

/**
 * Data-backed lane audit (report only, never a gate): how many crate tracks carry the scenario lane in their cached
 * styles, and which pool-lane tracks have styles that contradict the pool, so pools can be corrected from data.
 */
export function auditCrate(lane: string, crate: AuditCrateTrack[]) {
  const tagged = crate.filter((c) => c.styles?.length);
  return {
    tagConfirmed: crate.filter((c) => c.styles?.includes(lane)).length,
    inLanePool: crate.filter((c) => c.inLanePool).length,
    untagged: crate.length - tagged.length,
    contradictions: crate
      .filter((c) => c.inLanePool && c.styles?.length && !c.styles.includes(lane))
      .map(({ artist, title, styles }) => ({ artist, title, styles: styles! })),
  };
}
