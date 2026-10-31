import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BLOCK_STATUSES, FetchError, createFetcher, type Fetcher } from '../../../scripts/scraper/fetchPage';
import { BASE_URL, parseSearch } from '../../../scripts/scraper/parseSearch';
import { parseTracklist } from '../../../scripts/scraper/parseTracklist';
import { trackKeyOf } from '../../types/track';
import { JsonAdjacencyStore, type AdjacencyStore } from './store';

export const SEARCHED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BACKOFF_MS = 24 * 60 * 60 * 1000;
export const QUEUE_PAUSE_MS = 30 * 60 * 1000;
export const TOP_TRACKLISTS = 3;

export const LIVE_STATE_PATH = path.join(process.cwd(), 'data', 'index', 'live-state.json');

interface LiveState {
  searched: Record<string, number>; // trackKey -> searched-at (ms)
  backoff: Record<string, number>; // trackKey -> backed off until (ms)
  pausedUntil?: number; // whole queue stopped until (ms)
}

export type LiveStore = AdjacencyStore & {
  setPlayCount(trackKey: string, count: number): void;
};

export interface IngestorDeps {
  fetcher: Fetcher;
  store: LiveStore;
  statePath: string;
  now?: () => number;
  log?: (line: string) => void;
}

interface Job {
  artist: string;
  title: string;
  key: string;
}

const isBlock = (err: unknown) => err instanceof FetchError && BLOCK_STATUSES.includes(err.status);

/** Picks the ajax-search hit matching the seed track and returns its play_count. */
export function parsePlayCount(json: string, artist: string, title: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const data = (parsed as { data?: Record<string, { properties?: Record<string, unknown> }> })?.data;
  if (!data || typeof data !== 'object') return undefined;
  const want = trackKeyOf(artist, title);
  const wantTitle = want.split('|')[1];
  let titleOnly: number | undefined;
  for (const entry of Object.values(data)) {
    const p = entry?.properties;
    if (!p) continue;
    const count = Number(p.play_count);
    if (!Number.isFinite(count)) continue;
    const names = Array.isArray(p.artists)
      ? (p.artists as Array<{ properties?: { artistname?: string } } & { artistname?: string }>)
          .map((a) => a?.properties?.artistname ?? a?.artistname ?? '')
          .join(' ')
      : '';
    const trackname = String(p.trackname ?? '');
    if (names && trackKeyOf(names, trackname) === want) return count;
    const full = String(p.fulltrackname ?? '');
    const sep = full.indexOf(' - ');
    if (sep > 0 && trackKeyOf(full.slice(0, sep), full.slice(sep + 3)) === want) return count;
    if (titleOnly === undefined && trackKeyOf('', trackname || full).split('|')[1] === wantTitle) titleOnly = count;
  }
  return titleOnly;
}

export function createIngestor(deps: IngestorDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const queue: Job[] = [];
  const pending = new Map<string, 'queued' | 'running'>();
  let pumping = false;
  let idle: Promise<void> = Promise.resolve();

  const readState = (): LiveState => {
    try {
      if (existsSync(deps.statePath)) {
        const s = JSON.parse(readFileSync(deps.statePath, 'utf8')) as Partial<LiveState>;
        return { searched: s.searched ?? {}, backoff: s.backoff ?? {}, pausedUntil: s.pausedUntil };
      }
    } catch {
      /* corrupt state file: start fresh */
    }
    return { searched: {}, backoff: {} };
  };
  const writeState = (s: LiveState) => {
    mkdirSync(path.dirname(deps.statePath), { recursive: true });
    const tmp = `${deps.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, deps.statePath);
  };
  const update = (fn: (s: LiveState) => void) => {
    const s = readState();
    fn(s);
    writeState(s);
  };

  async function runJob(job: Job): Promise<void> {
    const results = parseSearch(await deps.fetcher.search(`${job.artist} ${job.title}`)).slice(0, TOP_TRACKLISTS);
    for (const r of results) {
      if (await deps.store.hasTracklist(r.id)) continue;
      try {
        const tl = parseTracklist(await deps.fetcher.get(r.url));
        await deps.store.ingest(tl.id, tl.tracks);
        log(`live: indexed ${tl.id} (${tl.tracks.length} tracks) for ${job.key}`);
      } catch (err) {
        if (isBlock(err)) throw err;
        log(`live: skipped ${r.url}: ${(err as Error).message}`);
      }
    }
    try {
      const q = encodeURIComponent(`${job.artist} ${job.title}`);
      const json = await deps.fetcher.get(`${BASE_URL}/ajax/search_track.php?p=${q}&noIDFieldCheck=true&fixedMode=true&sf=p`, {
        headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
      });
      const count = parsePlayCount(json, job.artist, job.title);
      if (count !== undefined) deps.store.setPlayCount(job.key, count);
    } catch (err) {
      if (isBlock(err)) throw err;
      log(`live: play_count lookup failed for ${job.key}: ${(err as Error).message}`);
    }
  }

  async function pump(): Promise<void> {
    while (queue.length) {
      const job = queue.shift()!;
      pending.set(job.key, 'running');
      try {
        await runJob(job);
        update((s) => {
          s.searched[job.key] = now();
          delete s.backoff[job.key];
        });
      } catch (err) {
        log(`live: job failed for ${job.key}: ${(err as Error).message}`);
        const block = isBlock(err);
        update((s) => {
          s.backoff[job.key] = now() + BACKOFF_MS;
          if (block) s.pausedUntil = now() + QUEUE_PAUSE_MS;
        });
        if (block) {
          for (const j of queue.splice(0)) pending.delete(j.key);
          log('live: site is blocking requests; queue stopped for 30 minutes');
        }
      } finally {
        pending.delete(job.key);
      }
    }
    // Same tick as the empty-queue check, so a job enqueued right after can't be stranded.
    pumping = false;
  }

  return {
    /** Resolves once the decision is made (no network); `digging` is true while a job for this track is queued or running. */
    async ensureNeighborsFor(artist: string, title: string): Promise<{ digging: boolean }> {
      const key = trackKeyOf(artist, title);
      if (!artist.trim() || !title.trim()) return { digging: false };
      if (pending.has(key)) return { digging: true };
      if ((await deps.store.getNeighbors(key)).length > 0) return { digging: false };
      const t = now();
      const s = readState();
      if ((s.pausedUntil ?? 0) > t) return { digging: false };
      if ((s.backoff[key] ?? 0) > t) return { digging: false };
      if (t - (s.searched[key] ?? -Infinity) < SEARCHED_TTL_MS) return { digging: false };
      queue.push({ artist, title, key });
      pending.set(key, 'queued');
      if (!pumping) {
        pumping = true;
        idle = pump().catch((err) => {
          pumping = false;
          log(`live: queue error: ${(err as Error).message}`);
        });
      }
      return { digging: true };
    },
    isDigging: (artist: string, title: string) => pending.has(trackKeyOf(artist, title)),
    /** Resolves when the queue has drained (for tests and the smoke script). */
    whenIdle: () => idle,
  };
}

type Ingestor = ReturnType<typeof createIngestor>;

const GLOBAL_KEY = Symbol.for('setarchitect.liveIngestor');

/** Live fetching is off under tests and when SETARCHITECT_LIVE=0. */
export function liveEnabled(): boolean {
  return process.env.SETARCHITECT_LIVE !== '0' && process.env.NODE_ENV !== 'test';
}

function singleton(): Ingestor {
  const g = globalThis as unknown as Record<symbol, Ingestor | undefined>;
  return (g[GLOBAL_KEY] ??= createIngestor({
    fetcher: createFetcher(),
    store: new JsonAdjacencyStore(path.join(process.cwd(), 'data', 'index', 'adjacency.json')),
    statePath: LIVE_STATE_PATH,
    log: (line) => console.log(line),
  }));
}

/** Fire-and-forget safe: never throws, never waits on the network. */
export async function ensureNeighborsFor(artist: string, title: string): Promise<{ digging: boolean }> {
  if (!liveEnabled()) return { digging: false };
  try {
    return await singleton().ensureNeighborsFor(artist, title);
  } catch (err) {
    console.error(`live: ensureNeighborsFor failed: ${(err as Error).message}`);
    return { digging: false };
  }
}

export function isDigging(artist: string, title: string): boolean {
  return liveEnabled() && singleton().isDigging(artist, title);
}
