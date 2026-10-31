export const REQUEST_BUDGET: Record<string, number> = { spotify: 150, deezer: 400, itunes: 150, musicbrainz: 200 };
export const DEGRADED_INVALID_RATE = 0.1;
/** Stage-2 version provider: only exercised inside the merged target. */
export const SINGLE_TARGET_EXCLUDED = new Set(['musicbrainz']);

export interface Breaker {
  cooldownUntil(name: any, now?: number): number;
  recordFailure(name: any, err: unknown, now?: number): void;
}

/** 429 from anyone, or Apple's bare 403. Never retried. */
export function isRateLimited(provider: string, err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status === 429 || (provider === 'itunes' && status === 403);
}

export function selectSingleProviders<P extends { name: string; configured(): boolean }>(
  list: P[],
  breaker: Breaker | null,
  now = Date.now(),
): { run: P[]; skipped: Array<{ name: string; reason: string; until?: number }> } {
  const run: P[] = [];
  const skipped: Array<{ name: string; reason: string; until?: number }> = [];
  for (const p of list) {
    if (SINGLE_TARGET_EXCLUDED.has(p.name)) {
      skipped.push({ name: p.name, reason: 'only exercised inside the merged target' });
    } else if (!p.configured()) {
      skipped.push({ name: p.name, reason: 'not configured' });
    } else {
      const until = breaker?.cooldownUntil(p.name, now) ?? 0;
      if (until > now) skipped.push({ name: p.name, reason: 'breaker open', until });
      else run.push(p);
    }
  }
  return { run, skipped };
}

/** Thrown instead of calling a provider when the harness's own budget, pacing or breaker forbids it. */
export class BenchThrottled extends Error {
  constructor(public provider: string, public reason: 'budget' | 'pacing' | 'breaker') {
    super(`${provider} throttled by bench (${reason})`);
  }
}

/** Counts requests against a hard budget; `initial` carries today's earlier usage. */
export class RequestGate {
  count: number;
  constructor(
    private readonly budget: number | undefined,
    initial = 0,
    private readonly onTake?: (count: number) => void,
  ) {
    this.count = initial;
  }
  take(): boolean {
    if (this.budget !== undefined && this.count >= this.budget) return false;
    this.count++;
    this.onTake?.(this.count);
    return true;
  }
}

/** Local calendar day, e.g. 2026-11-01. */
export function dayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface DailyStore {
  read(): string | null;
  write(text: string): void;
}

export function loadDailyCounts(store: DailyStore, day: string): Record<string, number> {
  try {
    const j = JSON.parse(store.read() ?? '{}') as { day?: string; counts?: Record<string, number> };
    return j.day === day && j.counts ? j.counts : {};
  } catch {
    return {};
  }
}

export function saveDailyCounts(store: DailyStore, day: string, counts: Record<string, number>): void {
  try {
    store.write(JSON.stringify({ day, counts }));
  } catch {
    // best-effort; the in-memory gate still holds for this run
  }
}

export function budgetFor(name: string, env: Record<string, string | undefined> = process.env): number | undefined {
  const o = Number(env[`BENCH_BUDGET_${name.toUpperCase()}`]);
  return Number.isFinite(o) && o > 0 ? o : REQUEST_BUDGET[name];
}

/**
 * Wraps a provider so every call is gated by the shared budget, the breaker and a minimum gap.
 * A refused call throws BenchThrottled (never reaches the network); a 429 opens the shared breaker.
 */
export interface GuardedProvider<N extends string, R> {
  name: N;
  configured(): boolean;
  search(query: string, opts?: { limit?: number }): Promise<R>;
}

export function guardProvider<N extends string, R>(
  p: GuardedProvider<N, R>,
  o: { gate: RequestGate; breaker: Breaker | null; gapMs: number; onThrottle?: (e: BenchThrottled) => void; now?: () => number },
): GuardedProvider<N, R> {
  const now = o.now ?? Date.now;
  let last = -Infinity;
  const refuse = (reason: BenchThrottled['reason']): never => {
    const e = new BenchThrottled(p.name, reason);
    o.onThrottle?.(e);
    throw e;
  };
  return {
    name: p.name,
    configured: () => p.configured(),
    search: async (q: string, opts?: { limit?: number }) => {
      const t = now();
      if ((o.breaker?.cooldownUntil(p.name, t) ?? 0) > t) refuse('breaker');
      if (t - last < o.gapMs) refuse('pacing');
      if (!o.gate.take()) refuse('budget');
      last = t;
      try {
        return await p.search(q, opts);
      } catch (err) {
        if (isRateLimited(p.name, err)) o.breaker?.recordFailure(p.name, err, t);
        throw err;
      }
    },
  };
}

export function degradedSummary(perQuery: string[][]): { text: string; invalid: string[] } {
  const counts: Record<string, number> = {};
  for (const d of perQuery) for (const p of d) counts[p] = (counts[p] ?? 0) + 1;
  const n = Math.max(1, perQuery.length);
  return {
    text: Object.entries(counts).map(([p, c]) => `${p}:${c}/${n}`).join(' ') || 'none',
    invalid: Object.entries(counts).filter(([, c]) => c / n > DEGRADED_INVALID_RATE).map(([p]) => p),
  };
}

export function runStatus(o: {
  degradedInvalid: string[];
  errored: number;
  total: number;
  budgetExceeded: boolean;
  rateLimitedUntil?: number;
  /** Providers the harness itself refused on >10% of queries. */
  throttledPartial?: string[];
}): string {
  if (o.rateLimitedUntil) return `ABORTED (rate-limited until ${new Date(o.rateLimitedUntil).toLocaleString()})`;
  if (o.budgetExceeded) return 'ABORTED (budget)';
  if (o.degradedInvalid.length) return `INVALID (degraded >10%: ${o.degradedInvalid.join(', ')})`;
  if (o.errored > DEGRADED_INVALID_RATE * o.total) return 'INVALID (>10% errored)';
  if (o.throttledPartial?.length) {
    return `PARTIAL (throttled by bench >10%: ${o.throttledPartial.join(', ')}; not valid for acceptance)`;
  }
  return 'ok';
}
