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

/** Counts requests against a hard per-run budget. */
export class RequestGate {
  count = 0;
  constructor(private readonly budget: number | undefined) {}
  take(): boolean {
    if (this.budget !== undefined && this.count >= this.budget) return false;
    this.count++;
    return true;
  }
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
}): string {
  if (o.rateLimitedUntil) return `ABORTED (rate-limited until ${new Date(o.rateLimitedUntil).toLocaleString()})`;
  if (o.budgetExceeded) return 'ABORTED (budget)';
  if (o.degradedInvalid.length) return `INVALID (degraded >10%: ${o.degradedInvalid.join(', ')})`;
  if (o.errored > DEGRADED_INVALID_RATE * o.total) return 'INVALID (>10% errored)';
  return 'ok';
}
