import { LANES } from '../../src/lib/style/taxonomy';
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
export const SHUFFLE_SEED = 20261102;

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

export interface RatingTrack {
  artist: string;
  title: string;
  previewUrl?: string;
  youtubeUrl?: string;
}

export interface RatingFile {
  version: 1;
  scenarios: Array<{ id: string; name: string; template: ArcTemplate; set: TrackRef[]; tracks: RatingTrack[] }>;
}

/** The blind file: the set and the top-10 tracks only (shuffled), never scores, reasons or compliance. */
export function buildRatingFile(
  results: Array<{ scenario: Scenario; suggestions: Suggestion[] }>,
  seed = SHUFFLE_SEED,
): RatingFile {
  return {
    version: 1,
    scenarios: results.map(({ scenario, suggestions }, i) => ({
      id: scenario.id,
      name: scenario.name,
      template: scenario.template,
      set: scenario.set.map(({ artist, title }) => ({ artist, title })),
      tracks: seededShuffle(suggestions.slice(0, TOP_N), seed + i).map(({ track: t }) => {
        const out: RatingTrack = { artist: t.artist, title: t.title };
        if (t.previewUrl) out.previewUrl = t.previewUrl;
        if (t.youtubeUrl) out.youtubeUrl = t.youtubeUrl;
        return out;
      }),
    })),
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
