import { RETRYABLE_REASONS, isComplete, type IncompleteReason } from './completeness';
import { getEntry, setRetry } from './metadataCache';
import { trackKeyOf, type Track } from '@/types/track';

export const RETRY_BACKOFF_MS = [5 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

interface Deps {
  now: () => number;
  /** Arms a timer; returning undefined means "no real timer" (tests). */
  setTimer: (fn: () => void, ms: number) => unknown;
  resolve: (artist: string, title: string, opts?: { without?: string[] }) => Promise<Track>;
}

interface Queue {
  deps: Partial<Deps>;
  injected: boolean;
  jobs: Array<{ key: string; artist: string; title: string; without?: string[] }>;
  timers: Map<string, unknown>;
  running: boolean;
}

// In-process singleton (like the live ingestor): survives Next dev module reloads.
const GLOBAL_KEY = Symbol.for('setarchitect.reresolve');
const state = (): Queue => {
  const g = globalThis as unknown as Record<symbol, Queue>;
  return (g[GLOBAL_KEY] ??= { deps: {}, injected: false, jobs: [], timers: new Map(), running: false });
};

const MAX_TIMER_MS = 2 ** 31 - 1;

const realDeps = (q: Queue): Deps => ({
  now: q.deps.now ?? Date.now,
  setTimer:
    q.deps.setTimer ??
    ((fn, ms) => {
      const t = setTimeout(fn, Math.min(ms, MAX_TIMER_MS));
      (t as { unref?: () => void }).unref?.(); // never keep the process alive for a retry
      return t;
    }),
  resolve:
    q.deps.resolve ??
    (async (artist, title, opts) => {
      const { resolveWithStatus } = await import('./resolver');
      // the exclusion is intentional (crate fill): it must survive every hop of the retry chain
      return resolveWithStatus(artist, title, { force: true, ...(opts?.without?.length ? { without: opts.without, retryWithout: opts.without } : {}) });
    }),
});

/** Tests inject deps; otherwise the queue is disabled under NODE_ENV=test (no real timers). */
export function setReresolveDeps(deps: Partial<Deps>): void {
  const q = state();
  q.deps = deps;
  q.injected = true;
}

export function resetReresolve(): void {
  const q = state();
  for (const t of q.timers.values()) clearTimeout(t as ReturnType<typeof setTimeout>);
  q.timers.clear();
  q.jobs = [];
  q.deps = {};
  q.injected = false;
  q.running = false;
}

/**
 * Plans the next retry for a track that came back incomplete. Only breaker/timeout reasons are retried, on
 * RETRY_BACKOFF_MS by attempt count; returns the retryAt (persisted in the metadata cache so the client can
 * show it) or undefined when the reason is permanent or the schedule is exhausted. `without` (adapters the first
 * attempt left out, e.g. iTunes for the background crate fill) is carried into the retry job.
 */
export function scheduleRetry(artist: string, title: string, reason: IncompleteReason, without?: string[]): number | undefined {
  if (!RETRYABLE_REASONS.includes(reason)) return undefined;
  const q = state();
  const d = realDeps(q);
  const key = trackKeyOf(artist, title);
  const attempts = getEntry(key)?.attempts ?? 1;
  const delay = RETRY_BACKOFF_MS[attempts - 1];
  if (delay === undefined) {
    setRetry(key, undefined);
    return undefined;
  }
  const retryAt = d.now() + delay;
  setRetry(key, retryAt);
  if (process.env.NODE_ENV === 'test' && !q.injected) return retryAt;
  const prev = q.timers.get(key);
  if (prev) clearTimeout(prev as ReturnType<typeof setTimeout>);
  q.timers.set(
    key,
    d.setTimer(() => {
      q.timers.delete(key);
      if (!q.jobs.some((j) => j.key === key)) q.jobs.push({ key, artist, title, ...(without?.length ? { without } : {}) });
      void drain(q);
    }, delay)
  );
  return retryAt;
}

async function drain(q: Queue): Promise<void> {
  if (q.running) return;
  q.running = true;
  try {
    for (let job = q.jobs.shift(); job; job = q.jobs.shift()) {
      const entry = getEntry(job.key);
      if (entry && isComplete({ id: '', artist: '', title: '', sources: {}, ...entry.fields })) continue;
      try {
        // resolveWithStatus honours breaker cooldowns and budgets, updates the metadata cache and schedules the
        // next retry itself; this only covers an injected resolver that doesn't
        const t = await realDeps(q).resolve(job.artist, job.title, job.without ? { without: job.without } : undefined);
        if (t.unresolved && t.unresolved.retryAt === undefined) scheduleRetry(job.artist, job.title, t.unresolved.reason, job.without);
      } catch {
        // a failed retry is dropped; the client's next request resolves afresh
      }
    }
  } finally {
    q.running = false;
  }
}
