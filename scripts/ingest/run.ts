import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../../src/lib/dataDir';
import { createIngestor, LIVE_STATE_PATH } from '../../src/lib/adjacency/live';
import { ADJACENCY_PATH } from '../../src/lib/adjacency';
import { JsonAdjacencyStore } from '../../src/lib/adjacency/store';
import type { AdjacencyStats, TrackSummary } from '../../src/lib/adjacency/store';
import { trackKeyOf } from '../../src/types/track';
import { createFetcher, FetchError, BLOCK_STATUSES, SOFT_BLOCK_STATUS, type Fetcher } from '../scraper/fetchPage';
import { acquireLock, pidAlive, releaseLock, type IsAlive } from './lock';

export const JOB_GAP_MS = 20_000;
export const EMPTY_FRONTIER_SLEEP_MS = 30 * 60_000;

export interface SeedTrack {
  artist: string;
  title: string;
}

interface StateView {
  searched: Record<string, number>;
  backoff: Record<string, number>;
  pausedUntil?: number;
}

export interface Counters {
  softBlocks: number;
  hardBlocks: number;
}

/**
 * Frontier: seed tracks first (file order), then indexed tracks by descending neighbor count; keys searched
 * within the TTL window or backed off are skipped. (The ingestor re-checks the searched TTL; filtering here
 * only stops the driver from spinning on keys it would refuse.)
 */
export function nextSeeds(
  store: { trackSummaries(): TrackSummary[] },
  state: StateView,
  limit: number,
  seeds: SeedTrack[] = [],
  at: number = Date.now(),
  searchedTtlMs = 7 * 24 * 60 * 60 * 1000
): SeedTrack[] {
  const seen = new Set<string>();
  const out: SeedTrack[] = [];
  const eligible = (key: string) =>
    !seen.has(key) && (state.backoff[key] ?? 0) <= at && at - (state.searched[key] ?? -Infinity) >= searchedTtlMs;
  const take = (artist: string, title: string) => {
    const key = trackKeyOf(artist, title);
    if (!artist.trim() || !title.trim() || !eligible(key)) return;
    seen.add(key);
    out.push({ artist, title });
  };
  for (const s of seeds) take(s.artist, s.title);
  const ranked = [...store.trackSummaries()].sort((a, b) => b.neighborCount - a.neighborCount);
  for (const t of ranked) {
    if (out.length >= limit) break;
    take(t.artist, t.title);
  }
  return out.slice(0, limit);
}

export interface DriverDeps {
  ingestor: {
    ensureNeighborsFor(artist: string, title: string, opts?: { deepen?: boolean }): Promise<{ digging: boolean }>;
    whenIdle(): Promise<void>;
  };
  store: { trackSummaries(): TrackSummary[]; stats(): Promise<AdjacencyStats> };
  statePath: string;
  growthPath: string;
  lockPath: string;
  seeds: SeedTrack[];
  counters: Counters;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  signal?: AbortSignal;
  pid?: number;
  isAlive?: IsAlive;
}

const readState = (file: string): StateView => {
  try {
    if (existsSync(file)) {
      const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateView>;
      return { searched: s.searched ?? {}, backoff: s.backoff ?? {}, pausedUntil: s.pausedUntil };
    }
  } catch {
    /* corrupt: treat as empty */
  }
  return { searched: {}, backoff: {} };
};

/** Returns the process exit code: 1 when another driver is alive, otherwise 0 after an orderly stop. */
export async function runDriver(deps: DriverDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const pid = deps.pid ?? process.pid;
  // default sleep wakes early on abort so SIGTERM is honored within a long cool-down
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          deps.signal?.removeEventListener('abort', done);
          resolve();
        }
        deps.signal?.addEventListener('abort', done, { once: true });
      }));
  const stopped = () => deps.signal?.aborted === true;
  if (!acquireLock(deps.lockPath, { pid, isAlive: deps.isAlive, now })) {
    log('ingest: another driver is already running; exiting');
    return 1;
  }
  const nap = async (ms: number) => {
    if (!stopped()) await sleep(ms);
  };
  let jobs = 0;
  try {
    log(`ingest: driver started (pid ${pid})`);
    while (!stopped()) {
      const state = readState(deps.statePath);
      const pausedFor = (state.pausedUntil ?? 0) - now();
      if (pausedFor > 0) {
        log(`ingest: queue paused; sleeping ${Math.round(pausedFor / 60_000)} min`);
        await nap(pausedFor);
        continue;
      }
      const [seed] = nextSeeds(deps.store, state, 1, deps.seeds, now());
      if (!seed) {
        log('ingest: frontier empty; sleeping 30 min');
        await nap(EMPTY_FRONTIER_SLEEP_MS);
        continue;
      }
      const { digging } = await deps.ingestor.ensureNeighborsFor(seed.artist, seed.title, { deepen: true });
      if (digging) {
        await deps.ingestor.whenIdle();
        jobs++;
        const stats = await deps.store.stats();
        appendFileSync(
          deps.growthPath,
          JSON.stringify({
            ts: now(),
            tracklists: stats.tracklistCount,
            tracks: stats.trackCount,
            pairs: stats.pairCount,
            jobs,
            softBlocks: deps.counters.softBlocks,
            hardBlocks: deps.counters.hardBlocks,
          }) + '\n'
        );
      }
      await nap(JOB_GAP_MS);
    }
    return 0;
  } finally {
    releaseLock(deps.lockPath, pid);
    log('ingest: driver stopped; lock released');
  }
}

/** Counts block responses seen by the fetcher, for the growth log. */
export function countBlocks(inner: Fetcher, counters: Counters): Fetcher {
  const track = async (run: () => Promise<string>) => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof FetchError) {
        if (err.status === SOFT_BLOCK_STATUS) counters.softBlocks++;
        else if (BLOCK_STATUSES.includes(err.status)) counters.hardBlocks++;
      }
      throw err;
    }
  };
  return {
    get: (url, opts) => track(() => inner.get(url, opts)),
    search: (q) => track(() => inner.search(q)),
    setDelayScale: (s) => inner.setDelayScale?.(s),
  };
}

function loadSeeds(): SeedTrack[] {
  const root = process.cwd();
  const files = [path.join(root, 'bench/search/tracks.json'), path.join(root, 'data/seed/tracks.demo.json')];
  const out: SeedTrack[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const t of JSON.parse(readFileSync(f, 'utf8')) as Array<{ artist?: string; title?: string }>) {
      if (t.artist && t.title) out.push({ artist: t.artist, title: t.title });
    }
  }
  return out;
}

async function main(): Promise<number> {
  const counters: Counters = { softBlocks: 0, hardBlocks: 0 };
  const store = new JsonAdjacencyStore(ADJACENCY_PATH);
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const ingestor = createIngestor({ fetcher: countBlocks(createFetcher(), counters), store, statePath: LIVE_STATE_PATH, log });
  const ac = new AbortController();
  const lockPath = dataDir('index', 'ingest.lock');
  const stop = () => ac.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return runDriver({
    ingestor,
    store,
    statePath: LIVE_STATE_PATH,
    growthPath: dataDir('index', 'growth.jsonl'),
    lockPath,
    seeds: loadSeeds(),
    counters,
    log,
    signal: ac.signal,
    isAlive: pidAlive,
  });
}

if (process.argv[1]?.endsWith('ingest/run.ts')) {
  main().then((code) => {
    process.exitCode = code;
  });
}
