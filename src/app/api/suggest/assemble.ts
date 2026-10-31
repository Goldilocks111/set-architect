import { suggestNext as engineSuggestNext } from '@/engine';
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
  resolveTrack?: (artist: string, title: string) => Promise<Track>;
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
const keyOf = (t: { artist: string; title: string }) => trackKeyOf(t.artist, t.title);

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
  const last = input.playlist[input.playlist.length - 1];

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
  const toResolve = external.filter((e) => {
    if (seen.has(e.key) || poolByKey.has(e.key)) return false;
    seen.add(e.key);
    return true;
  });
  // Resolves that finish inside the budget are used; the rest are dropped (the demo pool still ranks).
  const resolved: Array<Track | null> = toResolve.map(() => null);
  await withTimeout(
    Promise.all(
      toResolve.map(async (e, i) => {
        resolved[i] = await safe(deps.resolveTrack && (() => deps.resolveTrack!(e.artist, e.title)), null);
      })
    ),
    remaining(),
    undefined
  );

  const inSet = new Set(input.playlist.flatMap((t) => [t.id, keyOf(t)]));
  const candidates: Track[] = [];
  const candidateKeys = new Set<string>();
  for (const t of [...resolved, ...pool]) {
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
    deps.resolveTrack = resolver.resolveTrack;
    deps.getSimilarTracks = resolver.getSimilarTracks;
  } catch {
    // resolver unavailable: demo pool only
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
