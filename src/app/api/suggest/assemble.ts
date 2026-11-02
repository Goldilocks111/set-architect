import { suggestNext as engineSuggestNext } from '@/engine';
import { isComplete } from '@/lib/completeness';
import { demoTracks, isDemoMode } from '@/lib/demo';
import { trackKeyOf, type AdjacencyLookup, type ArcTemplate, type Suggestion, type Track } from '@/types/track';

type DisplayName = { artist: string; title: string };

/** A neighbor flagged `sample` came from the generated demo adjacency, not scraped sets. */
type Neighbor = Awaited<ReturnType<AdjacencyLookup['getNeighbors']>>[number] & { sample?: boolean };

export type AdjacencyHandle = {
  getNeighbors(trackKey: string): Promise<Neighbor[]>;
  pairCount: number;
  trackCount: number;
  /** Display artist/title the index recorded for a normalized trackKey. */
  nameOf?: (trackKey: string) => DisplayName | undefined;
  /** Number of 1001TL sets a track appears in, when the live enrichment recorded it. */
  playCountOf?: (trackKey: string) => number | undefined;
};

/** Max score added for DJ-set popularity; log-scaled so 1000+ sets saturates it. */
export const PLAY_COUNT_MAX_BONUS = 0.05;
export const playCountBonus = (n: number) => PLAY_COUNT_MAX_BONUS * Math.min(1, Math.log10(1 + n) / 3);

/** Optional collaborators; anything missing, throwing or too slow degrades to the demo pool. */
export interface SuggestDeps {
  /** Cached resolve (resolveWithStatus): writes the metadata cache; `signal` stops the adapter chain at the budget. */
  resolveTrack?: (artist: string, title: string, opts?: { budgetMs?: number; signal?: AbortSignal }) => Promise<Track>;
  /** Metadata-cache lookup by trackKey; a complete hit supplies a candidate without any provider call. */
  getCachedEntry?: (key: string) => { fields: Partial<Track>; sources?: Record<string, string> } | undefined;
  getSimilarTracks?: (artist: string, title: string) => Promise<Array<{ artist: string; title: string; match: number }>>;
  loadAdjacency?: () => Promise<AdjacencyHandle>;
  suggestNext?: typeof engineSuggestNext;
  /** Overall budget for every external lookup in one request. */
  budgetMs?: number;
  /** Per-call cap for the adjacency and similarity lookups. */
  callTimeoutMs?: number;
}

export const SUGGEST_BUDGET_MS = 5000;
export const SUGGEST_CALL_TIMEOUT_MS = 2500;

export interface SuggestInput {
  playlist: Track[];
  template: ArcTemplate;
  plannedLength: number;
}

const MAX_EXTERNAL = 8;
/** Cache misses resolved per refresh; the rest wait for a later refresh (by then earlier ones are cached). */
export const MAX_CANDIDATE_RESOLVES = 4;
/** Candidate resolves running at once across all suggest requests, so they can't starve the user's own resolves. */
export const MAX_CONCURRENT_CANDIDATE_RESOLVES = 2;
const keyOf = (t: { artist: string; title: string }) => trackKeyOf(t.artist, t.title);

interface Limiter {
  active: number;
  waiters: Array<() => void>;
  inflight: Map<string, Promise<Track | null>>;
}
const limiter: Limiter = { active: 0, waiters: [], inflight: new Map() };

export function resetCandidateLimiter(): void {
  limiter.active = 0;
  limiter.waiters = [];
  limiter.inflight.clear();
}

/** Resolves when `p` settles or `signal` aborts (then with null). */
function untilAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(null);
      }
    );
  });
}

/** Takes a global slot; false when the request's budget ran out while waiting. */
function acquireSlot(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (limiter.active < MAX_CONCURRENT_CANDIDATE_RESOLVES) {
    limiter.active++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const grant = () => {
      signal.removeEventListener('abort', onAbort);
      resolve(true); // active was incremented by releaseSlot on our behalf
    };
    const onAbort = () => {
      limiter.waiters = limiter.waiters.filter((w) => w !== grant);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    limiter.waiters.push(grant);
  });
}

function releaseSlot(): void {
  const next = limiter.waiters.shift();
  if (next) next();
  else limiter.active = Math.max(0, limiter.active - 1);
}

async function safe<T>(fn: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
  if (!fn) return fallback;
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Resolves to `fallback` if `p` hasn't settled within `ms`; rejections also yield `fallback`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Last resort when the index has no display name: title-cased normalized key parts. */
export function displayFromKey(k: string): DisplayName {
  const [artist = '', title = ''] = k.split('|');
  return { artist: titleCase(artist), title: titleCase(title) };
}

export async function assembleSuggestions(
  input: SuggestInput,
  deps: SuggestDeps
): Promise<{ suggestions: Suggestion[] }> {
  const pool = demoTracks();
  const poolByKey = new Map(pool.map((t) => [keyOf(t), t]));
  // Incomplete set tracks have no usable essentials, so they can't anchor neighbor/similarity lookups.
  const last = input.playlist.filter(isComplete).pop();

  const adjacency = new Map<string, number>();
  const similarity = new Map<string, number>();
  const sampleKeys = new Set<string>();
  let playCountOf: AdjacencyHandle['playCountOf'];
  const external: Array<{ artist: string; title: string; key: string }> = [];
  const deadline = Date.now() + (deps.budgetMs ?? SUGGEST_BUDGET_MS);
  const remaining = () => Math.max(0, deadline - Date.now());
  const callCap = () => Math.min(deps.callTimeoutMs ?? SUGGEST_CALL_TIMEOUT_MS, remaining());

  if (last) {
    const lastKey = keyOf(last);
    let nameOf: AdjacencyHandle['nameOf'];
    const [neighbors, similar] = await Promise.all([
      withTimeout(
        safe(
          deps.loadAdjacency &&
            (async () => {
              const handle = await deps.loadAdjacency!();
              nameOf = handle.nameOf;
              playCountOf = handle.playCountOf;
              return handle.getNeighbors(lastKey);
            }),
          []
        ),
        callCap(),
        []
      ),
      withTimeout(safe(deps.getSimilarTracks && (() => deps.getSimilarTracks!(last.artist, last.title)), []), callCap(), []),
    ]);

    neighbors
      .filter((n) => n.direction === 'after' && n.trackKey !== lastKey)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_EXTERNAL)
      .forEach((n) => {
        if (n.sample) sampleKeys.add(n.trackKey);
        adjacency.set(n.trackKey, (adjacency.get(n.trackKey) ?? 0) + n.count);
        external.push({ ...(nameOf?.(n.trackKey) ?? displayFromKey(n.trackKey)), key: n.trackKey });
      });

    [...similar]
      .sort((a, b) => b.match - a.match)
      .slice(0, MAX_EXTERNAL)
      .forEach((s) => {
        const key = keyOf(s);
        similarity.set(key, Math.max(similarity.get(key) ?? 0, s.match));
        external.push({ artist: s.artist, title: s.title, key });
      });
  }

  const seen = new Set<string>();
  const cached: Track[] = [];
  const toResolve: typeof external = [];
  for (const e of external) {
    if (seen.has(e.key) || poolByKey.has(e.key)) continue;
    seen.add(e.key);
    // Cache first: a complete entry costs no provider call and no share of the external-lookup budget.
    const entry = await safe(deps.getCachedEntry && (async () => deps.getCachedEntry!(e.key)), undefined);
    const hit: Track | undefined = entry && {
      ...entry.fields,
      id: `cache-${e.key}`,
      artist: e.artist,
      title: e.title,
      sources: { ...entry.sources },
    };
    if (hit && isComplete(hit)) cached.push(hit);
    else toResolve.push(e);
  }
  // Resolves that finish inside the budget are used; at the budget the signal stops the rest (what they found is
  // cached as 'timeout' and retried server-side, so a later refresh gets them from the cache).
  const picked = deps.resolveTrack ? toResolve.slice(0, MAX_CANDIDATE_RESOLVES) : [];
  const resolved: Array<Track | null> = picked.map(() => null);
  if (picked.length) {
    const ctrl = new AbortController();
    const budget = setTimeout(() => ctrl.abort(), remaining());
    const resolveOne = async (e: (typeof picked)[number]): Promise<Track | null> => {
      const shared = limiter.inflight.get(e.key);
      if (shared) return untilAbort(shared, ctrl.signal);
      if (!(await acquireSlot(ctrl.signal))) return null;
      const p = safe(() => deps.resolveTrack!(e.artist, e.title, { budgetMs: remaining(), signal: ctrl.signal }), null);
      limiter.inflight.set(e.key, p);
      try {
        return await untilAbort(p, ctrl.signal);
      } finally {
        if (limiter.inflight.get(e.key) === p) limiter.inflight.delete(e.key);
        releaseSlot();
      }
    };
    let next = 0;
    const worker = async () => {
      while (!ctrl.signal.aborted && next < picked.length) {
        const i = next++;
        resolved[i] = await resolveOne(picked[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_CANDIDATE_RESOLVES, picked.length) }, worker));
    clearTimeout(budget);
    ctrl.abort(); // nothing left running; also releases anyone still waiting on a shared promise
  }

  const inSet = new Set(input.playlist.flatMap((t) => [t.id, keyOf(t)]));
  const candidates: Track[] = [];
  const candidateKeys = new Set<string>();
  for (const t of [...cached, ...resolved, ...pool]) {
    if (!t) continue;
    const k = keyOf(t);
    if (inSet.has(t.id) || inSet.has(k) || candidateKeys.has(k)) continue;
    candidateKeys.add(k);
    candidates.push(t);
  }

  const suggest = deps.suggestNext ?? engineSuggestNext;
  const suggestions = suggest({
    playlist: input.playlist,
    candidates,
    template: input.template,
    plannedLength: input.plannedLength,
    adjacency,
    similarity,
  }).slice(0, 10);

  // The engine words co-occurrence as "real sets"; counts that came from the generated demo adjacency must not claim that.
  if (sampleKeys.size) {
    for (const s of suggestions) {
      if (!sampleKeys.has(keyOf(s.track))) continue;
      for (const r of s.reasons) {
        if (r.kind === 'cooccurrence') r.label = r.label.replace(/ real (sets?)$/, ' sample $1');
      }
    }
  }

  if (playCountOf) {
    let bonused = false;
    for (const s of suggestions) {
      const n = playCountOf(keyOf(s.track));
      if (!n || n < 1 || sampleKeys.has(keyOf(s.track))) continue;
      const bonus = playCountBonus(n);
      s.score += bonus;
      s.reasons.push({ kind: 'cooccurrence', label: `In ${n} DJ set${n === 1 ? '' : 's'}`, score: bonus / PLAY_COUNT_MAX_BONUS });
      bonused = true;
    }
    if (bonused) suggestions.sort((a, b) => b.score - a.score);
  }

  return { suggestions };
}

/** Loads the resolver/adjacency modules when they are present; each is independently optional. */
export async function loadSuggestDeps(): Promise<SuggestDeps> {
  const deps: SuggestDeps = {};
  try {
    const resolver = await import('@/lib/resolver');
    // the cached resolver: candidates land in the metadata cache, so a later refresh costs no provider call
    deps.resolveTrack = (artist, title, opts) => resolver.resolveWithStatus(artist, title, opts);
    deps.getSimilarTracks = resolver.getSimilarTracks;
  } catch {
    // resolver unavailable: demo pool only
  }
  try {
    deps.getCachedEntry = (await import('@/lib/metadataCache')).getEntry;
  } catch {
    // no cache: every candidate goes through the resolver
  }
  try {
    const adj = await import('@/lib/adjacency');
    const namesFrom = (file: string | undefined): Record<string, DisplayName> => {
      if (!file) return {};
      try {
        return adj.readData(file).names ?? {};
      } catch {
        return {};
      }
    };
    deps.loadAdjacency = async () => {
      const real = await adj.loadAdjacency();
      const demoPath = adj.DEMO_ADJACENCY_PATH;
      const names = { ...(isDemoMode() ? namesFrom(demoPath) : {}), ...namesFrom(adj.ADJACENCY_PATH) };
      const nameOf = (key: string) => names[key];
      // Only demo mode may fall back to the generated adjacency; otherwise the scraped index is the sole source.
      if (!demoPath || !isDemoMode()) return { ...real, nameOf };
      // The scraped index rarely covers the demo seed, so tracks it doesn't know fall back to the seeded demo adjacency.
      const demo = await adj.loadAdjacency(demoPath);
      return {
        pairCount: real.pairCount,
        trackCount: real.trackCount,
        nameOf,
        playCountOf: real.playCountOf,
        getNeighbors: async (key: string) => {
          const found = await real.getNeighbors(key);
          if (found.length) return found;
          return (await demo.getNeighbors(key)).map((n) => ({ ...n, sample: true }));
        },
      };
    };
  } catch {
    // no adjacency index: co-occurrence reasons omitted
  }
  return deps;
}
