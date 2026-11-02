import { trackKeyOf, type Track } from '@/types/track';
import { ESSENTIALS, RETRYABLE_REASONS, missingEssentials, type IncompleteReason } from './completeness';
import { getEntry, putPrior, putResolved, type CacheEntry } from './metadataCache';
import { scheduleRetry } from './reresolve';
import { searchDemoTracks } from './demo';
import { withTimeout } from './http';
import { analysePreview, ANALYSIS_TIMEOUT_MS } from './analysis/previewAnalysis';
import { acousticbrainzAdapter } from './sources/acousticbrainz';
import { deezerAdapter } from './sources/deezer';
import { getSongBpmAdapter } from './sources/getsongbpm';
import { itunesAdapter } from './sources/itunes';
import { lastfmConfigured, lastfmSimilar, type SimilarItem } from './sources/lastfm';
import { listenbrainzSimilar } from './sources/listenbrainz';
import { musicbrainzAdapter } from './sources/musicbrainz';
import { reccobeatsAdapter } from './sources/reccobeats';
import { soundstatAdapter } from './sources/soundstat';
import { spotifyAdapter } from './sources/spotify';
import type { SourceAdapter } from './sources/types';
import { youtubeAdapter } from './sources/youtube';
import { cachedMergedSearch } from './search/cache';
import { cooldownUntil, recordFailure, recordSuccess, takeBudget } from './search/breaker';
import { defaultProviders, firstRoundProviders, mergedSearch } from './search/merge';
import type { MergedHit } from './search/types';

export const ADAPTER_TIMEOUT_MS = 4000;

const GUARDED = new Set<string>(['spotify', 'deezer', 'itunes', 'musicbrainz']);
const isGuarded = (name: string): name is MergedHit['providers'][number] => GUARDED.has(name);

// youtube is appended last: keyless it only builds a search URL, so it costs nothing.
const ADAPTERS: SourceAdapter[] = [
  deezerAdapter,
  itunesAdapter,
  spotifyAdapter, // before soundstat/reccobeats: they key off the spotifyId it supplies
  getSongBpmAdapter,
  soundstatAdapter,
  reccobeatsAdapter,
  musicbrainzAdapter, // slow + 1 req/s: last, fills whatever is still missing
  acousticbrainzAdapter, // needs the mbid from musicbrainz
  youtubeAdapter,
];

// Fields where a given adapter may replace an earlier source's value: SoundStat's analysis beats earlier
// bpm/key estimates, and iTunes is the preferred previewUrl (Deezer's expires in ~15 min and is only a fallback).
// previewUrl must not be persisted long-term.
const OVERRIDES: Record<string, Array<keyof Track>> = { soundstat: ['bpm', 'camelot'], itunes: ['previewUrl'] };

/** Facts about one resolve pass, collected inside the loop so the reason is never guessed afterwards. */
interface ResolveRun {
  deadline?: number; // epoch ms; checked between adapters
  aborted: boolean; // set by the caller when it stops waiting: the loop must stop writing
  providersSkipped: boolean; // a guarded adapter was skipped by cooldown/budget, or errored (offline, 5xx, 429, timeout)
  without?: Set<string>; // adapters to leave out (background crate fill never touches iTunes)
  only?: Set<string>; // restrict to these adapters (preview refresh on a cache hit); skips preview analysis
  timedOut: boolean;
  deezerPreview?: string;
  analysed: boolean;
}

const newRun = (deadline?: number): ResolveRun => ({ deadline, aborted: false, providersSkipped: false, timedOut: false, analysed: false });

export async function resolveTrack(
  artist: string,
  title: string,
  hints: { spotifyId?: string } = {}
): Promise<Track> {
  return resolveInto(initialTrack(artist, title, hints), newRun());
}

function initialTrack(artist: string, title: string, hints: { spotifyId?: string }): Track {
  const track: Track = { id: trackKeyOf(artist, title), artist, title, sources: {} };
  if (hints.spotifyId) {
    track.spotifyId = hints.spotifyId;
    track.sources.spotifyId = 'caller';
  }
  return track;
}

async function resolveInto(track: Track, run: ResolveRun): Promise<Track> {
  for (const adapter of ADAPTERS) {
    if (run.aborted) return track;
    if (run.only && !run.only.has(adapter.name)) continue;
    if (run.without?.has(adapter.name)) continue;
    if (run.deadline !== undefined && Date.now() >= run.deadline) {
      run.timedOut = true;
      return track;
    }
    const guarded = isGuarded(adapter.name) ? adapter.name : undefined;
    try {
      if (!adapter.configured()) continue;
      // Enrichment shares the search providers' breaker and the app's Spotify budget: one add or a
      // suggestion refresh must not walk back into a lockout.
      if (guarded && (cooldownUntil(guarded) || !takeBudget(guarded, { app: true }))) {
        run.providersSkipped = true;
        continue;
      }
      const partial = await withTimeout(adapter.enrich({ ...track }), adapter.timeoutMs ?? ADAPTER_TIMEOUT_MS, adapter.name);
      if (run.aborted) return track;
      if (guarded) recordSuccess(guarded);
      if (adapter.name === 'deezer') run.deezerPreview = partial?.previewUrl;
      const overrides = OVERRIDES[adapter.name] ?? [];
      for (const [field, value] of Object.entries(partial ?? {}) as Array<[keyof Track, unknown]>) {
        if (value === undefined || value === null || field === 'sources' || field === 'id') continue;
        if (track[field] !== undefined && !overrides.includes(field)) continue;
        (track as unknown as Record<string, unknown>)[field] = value;
        track.sources[field] = adapter.fieldLabels?.[field] ?? adapter.name;
      }
    } catch (err) {
      if (guarded) {
        recordFailure(guarded, err);
        run.providersSkipped = true;
      }
      // a failing adapter is skipped; resolution continues with the rest
    }
  }
  // Last resort: estimate from the Deezer preview (never iTunes: Apple's terms restrict preview use).
  const missing = ESSENTIALS.filter((f) => track[f] === undefined);
  if (missing.length && run.deezerPreview && !run.aborted && !run.only) {
    run.analysed = true;
    try {
      const partial = await withTimeout(analysePreview(track.id, run.deezerPreview), ANALYSIS_TIMEOUT_MS, 'preview-analysis');
      if (run.aborted) return track;
      for (const f of missing) {
        const value = partial[f];
        if (value === undefined) continue;
        (track as unknown as Record<string, unknown>)[f] = value;
        track.sources[f] = 'preview-analysis';
      }
    } catch {
      // analysis is best-effort
    }
  }
  return track;
}

/** True when some adapter actually matched the track (youtube's keyless search link and the caller's hint don't count). */
function matchedAnyProvider(track: Track): boolean {
  return Object.entries(track.sources).some(([field, src]) => src !== 'caller' && field !== 'youtubeUrl');
}

function reasonFor(track: Track, run: ResolveRun): IncompleteReason {
  if (run.timedOut) return 'timeout';
  // A provider that errored or was skipped could have supplied the match/preview: retryable, not permanent.
  if (run.providersSkipped && (!matchedAnyProvider(track) || !run.deezerPreview)) return 'providers-unavailable';
  if (!matchedAnyProvider(track)) return 'not-found';
  if (!run.deezerPreview) return 'no-preview';
  return 'analysis-failed';
}

/** `base` with a cache entry's fields and sources laid over it. */
const fromEntry = (base: Track, entry: CacheEntry): Track => ({ ...base, ...entry.fields, sources: { ...base.sources, ...entry.sources } });

export const RESOLVE_BUDGET_MS = 45_000;
const NEGATIVE_CACHE_MS = 24 * 60 * 60_000;

/**
 * previewUrl expires within minutes and is never persisted, so a complete cache hit still asks the
 * preview-supplying adapters (through the usual breaker/budget guards) for a fresh one. Essentials stay cached.
 */
async function withFreshPreview(cached: Track, budgetMs: number): Promise<Track> {
  const track: Track = { ...cached, sources: { ...cached.sources } };
  const run = newRun(Date.now() + budgetMs);
  run.only = new Set(['deezer', 'itunes']);
  try {
    await withTimeout(resolveInto(track, run), budgetMs, 'preview refresh');
  } catch {
    // best-effort: the cached essentials are still good
  }
  run.aborted = true;
  return { ...track, sources: { ...track.sources } };
}

/**
 * resolveTrack + the completeness gate: consults the persistent metadata cache (a complete entry costs zero
 * adapter calls), keeps manual overrides, and marks a still-incomplete track with `unresolved` and why.
 * A retryable verdict is scheduled on the re-resolve queue here, so every caller gets the same retry/negative-cache
 * semantics. `force` skips the cache short-circuit (used by the re-resolve queue); `signal` stops the adapter chain
 * early (the suggest budget), and what was found so far is cached as 'timeout'.
 */
export async function resolveWithStatus(
  artist: string,
  title: string,
  opts: { budgetMs?: number; force?: boolean; hints?: { spotifyId?: string }; signal?: AbortSignal; without?: string[] } = {}
): Promise<Track> {
  const key = trackKeyOf(artist, title);
  const budgetMs = opts.budgetMs ?? RESOLVE_BUDGET_MS;
  const cached = getEntry(key);
  if (cached && !opts.force) {
    const fromCache: Track = { ...initialTrack(artist, title, {}), ...cached.fields, sources: { ...cached.sources } };
    const missingNow = missingEssentials(fromCache);
    if (!missingNow.length) return withFreshPreview(fromCache, budgetMs);
    // Every incomplete entry is served from cache (zero adapter calls) until it is due: a retryable one until
    // its retryAt; an exhausted/permanent one for 24 h. Otherwise each request would re-run every adapter.
    if (cached.reason) {
      const retryable = RETRYABLE_REASONS.includes(cached.reason) && cached.retryAt !== undefined;
      const until = retryable ? cached.retryAt! : cached.resolvedAt + NEGATIVE_CACHE_MS;
      if (until > Date.now()) {
        // nothing more is coming for this track (permanent reason or retries exhausted): the danceability prior may complete it
        const filled = retryable ? undefined : putPrior(key);
        const served = filled ? fromEntry(fromCache, filled) : fromCache;
        const missing = missingEssentials(served);
        if (!missing.length) return withFreshPreview(served, budgetMs);
        served.unresolved = { reason: cached.reason, missing, ...(cached.retryAt ? { retryAt: cached.retryAt } : {}) };
        return served;
      }
    }
  }

  const track = initialTrack(artist, title, opts.hints ?? {});
  const run = newRun(Date.now() + budgetMs);
  if (opts.without?.length) run.without = new Set(opts.without);
  const { signal } = opts;
  const stopped = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new Error('aborted'));
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  stopped.catch(() => {}); // only observed through the race below
  try {
    await Promise.race([withTimeout(resolveInto(track, run), budgetMs, 'resolve'), stopped]);
  } catch {
    run.timedOut = true;
  }
  run.aborted = true; // a late adapter must not keep mutating what we return
  const result: Track = { ...track, sources: { ...track.sources } };
  // What the track will look like once earlier cached fields and manual overrides are folded in.
  const prior = getEntry(key);
  const prospective: Track = { ...result, ...prior?.fields, sources: result.sources };
  for (const f of ESSENTIALS) if (prior?.sources[f] !== 'manual' && result[f] !== undefined) (prospective as unknown as Record<string, unknown>)[f] = result[f];
  const missing = missingEssentials(prospective);
  if (missing.length) result.unresolved = { reason: reasonFor(result, run), missing };
  const entry = putResolved(key, result);
  const merged: Track = { ...result, ...entry.fields, sources: { ...result.sources, ...entry.sources } };
  if (!missing.length) delete merged.unresolved;
  else if (merged.unresolved) {
    // after putResolved: the backoff step is picked from the entry's attempt count
    const retryAt = scheduleRetry(artist, title, merged.unresolved.reason);
    if (retryAt !== undefined) merged.unresolved = { ...merged.unresolved, retryAt };
    else {
      // resolution is done: fill the danceability prior if energy is known
      const filled = putPrior(key);
      if (filled) {
        const out = fromEntry(merged, filled);
        const still = missingEssentials(out);
        if (still.length) out.unresolved = { ...merged.unresolved, missing: still };
        else delete out.unresolved;
        return out;
      }
    }
  }
  return merged;
}

/** Stable across searches: the ISRC, else the merge key without the per-response "#n" collision suffix. */
export function trackIdOf(hit: MergedHit): string {
  return (hit.isrc ? `isrc-${hit.isrc}` : `search-${hit.key.replace(/#\d+$/, '')}`).slice(0, 200);
}

/** Maps one merged search hit to a Track; the title keeps the version so enrichment finds this exact recording. */
export function hitToTrack(hit: MergedHit, id = trackIdOf(hit)): Track {
  const label = hit.version.label;
  const track: Track = {
    id,
    artist: hit.artist,
    title: label ? `${hit.baseTitle} (${label})` : hit.baseTitle,
    sources: {},
  };
  const year = hit.releaseDate ? parseInt(hit.releaseDate.slice(0, 4), 10) : NaN;
  const fields: Partial<Track> = {
    version: label,
    durationMs: hit.durationMs,
    isrc: hit.isrc,
    popularity: hit.popularity,
    spotifyId: hit.spotifyId,
    spotifyUrl: hit.spotifyUrl,
    previewUrl: hit.previewUrl,
    artworkUrl: hit.artworkUrl,
    year: Number.isFinite(year) && year > 0 ? year : undefined,
  };
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    (track as unknown as Record<string, unknown>)[field] = value;
    if (field !== 'version' && field !== 'durationMs') track.sources[field] = hit.providers.join('+');
  }
  return track;
}

export async function searchTracks(query: string): Promise<Track[]> {
  const providers = defaultProviders().filter((p) => p.configured());
  const { hits, degraded } = await cachedMergedSearch(query, (q) => mergedSearch(q, { providers, appBudget: true }));
  const first = firstRoundProviders(providers);
  const asked = first.length ? first : providers;
  if (!hits.length && asked.length && asked.every((p) => degraded.includes(p.name))) return searchDemoTracks(query);
  const used = new Set<string>();
  return hits.map((hit) => {
    let id = trackIdOf(hit);
    if (used.has(id)) id = `search-${hit.key}`.slice(0, 200); // a genuine collision keeps its suffix
    used.add(id);
    return hitToTrack(hit, id);
  });
}

export async function getSimilarTracks(artist: string, title: string): Promise<SimilarItem[]> {
  if (lastfmConfigured()) {
    try {
      const res = await withTimeout(lastfmSimilar(artist, title), ADAPTER_TIMEOUT_MS, 'lastfm');
      if (res.length) return res;
    } catch {
      // fall through to ListenBrainz
    }
  }
  try {
    return await withTimeout(listenbrainzSimilar(artist, title), ADAPTER_TIMEOUT_MS, 'listenbrainz');
  } catch {
    return [];
  }
}

export function adapterHealth(): Array<{ name: string; configured: boolean }> {
  return [
    ...ADAPTERS.map((a) => ({ name: a.name, configured: a.configured() })),
    { name: 'lastfm', configured: lastfmConfigured() },
    { name: 'listenbrainz', configured: true },
  ];
}
