import fs from 'node:fs';
import { dataDir } from '@/lib/dataDir';
import { HttpError } from '@/lib/http';
import type { SearchResult } from './types';

type Name = SearchResult['provider'];

/** Cooldown when a provider throttles without saying for how long. */
export const THROTTLE_COOLDOWN_MS = 5 * 60_000;
/** Consecutive 403/5xx answers that open the breaker, and for how long. */
export const FAILURE_STREAK = 3;
export const STREAK_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 24 * 3600_000;
export const MB_BACKOFF_MS = 10_000;

// Persisted and shared through one file by every process (dev server, bench, scripts): each reads
// the file again when it changes and merges before writing, so nobody erases another's cooldown.
let until: Record<string, number> = {};
let seenMtimeMs = -1;
const streaks = new Map<string, number>();

const file = () => dataDir('search', 'provider-cooldowns.json');

function readFile(): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function load(): Record<string, number> {
  let mtime: number;
  try {
    mtime = fs.statSync(file()).mtimeMs;
  } catch {
    mtime = 0; // no file (yet, or deleted as a manual reset)
  }
  if (mtime !== seenMtimeMs) {
    seenMtimeMs = mtime;
    until = mtime ? readFile() : {};
  }
  return until;
}

function open(name: Name, ms: number, now: number): void {
  const merged = { ...readFile() };
  for (const [k, v] of Object.entries(load())) merged[k] = Math.max(merged[k] ?? 0, v);
  merged[name] = Math.max(merged[name] ?? 0, now + Math.min(ms, MAX_COOLDOWN_MS));
  until = merged;
  streaks.delete(name);
  try {
    fs.writeFileSync(file(), JSON.stringify(merged));
    seenMtimeMs = fs.statSync(file()).mtimeMs;
  } catch {
    // persistence is best-effort; the in-memory breaker still holds
  }
}

/** Epoch ms until which the provider must not be called, or 0. */
export function cooldownUntil(name: Name, now = Date.now()): number {
  const t = load()[name] ?? 0;
  return t > now ? t : 0;
}

export function recordSuccess(name: Name): void {
  streaks.delete(name);
}

function streak(name: Name, now: number): void {
  const n = (streaks.get(name) ?? 0) + 1;
  if (n >= FAILURE_STREAK) open(name, STREAK_COOLDOWN_MS, now);
  else streaks.set(name, n);
}

export function recordFailure(name: Name, err: unknown, now = Date.now()): void {
  if (!(err instanceof HttpError)) {
    // a provider that hangs on every call costs a full timeout per query: count timeouts like 5xx
    if (err instanceof Error && /timed out|timeout/i.test(err.message)) streak(name, now);
    return;
  }
  if (err.status === 429) return open(name, err.retryAfterMs ?? THROTTLE_COOLDOWN_MS, now);
  // Apple signals its rate limit with a bare 403.
  if (name === 'itunes' && err.status === 403) return open(name, err.retryAfterMs ?? THROTTLE_COOLDOWN_MS, now);
  // MusicBrainz answers 503 when a client exceeds 1 req/s.
  if (name === 'musicbrainz' && err.status === 503) return open(name, Math.max(err.retryAfterMs ?? 0, MB_BACKOFF_MS), now);
  if (err.status === 403 || err.status >= 500) streak(name, now);
}

export function resetBreakers(): void {
  until = {};
  seenMtimeMs = -1;
  streaks.clear();
  try {
    fs.rmSync(file(), { force: true });
  } catch {
    // nothing persisted
  }
}

/**
 * Calls allowed per provider per rolling minute, in this process. Apple documents roughly 20/min for the iTunes
 * Search API and answers 403 for minutes after it is exceeded. Spotify's dev-mode quota locked the app out for
 * ~14h once; the app (search + enrichment together) stays under 30/min. The Spotify budget is opt-in per call
 * (`app`), so the benchmark, which paces itself, measures search unthrottled.
 */
export const PER_MINUTE_BUDGET: Partial<Record<Name, number>> = { itunes: 20 };
export const APP_PER_MINUTE_BUDGET: Partial<Record<Name, number>> = { spotify: 30 };
const recentCalls = new Map<string, number[]>();

function take(key: string, limit: number, now: number): boolean {
  const calls = (recentCalls.get(key) ?? []).filter((t) => now - t < 60_000);
  const ok = calls.length < limit;
  if (ok) calls.push(now);
  recentCalls.set(key, calls);
  return ok;
}

/** False when the provider's budget for the last minute is spent; otherwise records the call. */
export function takeBudget(name: Name, opts: { app?: boolean } = {}, now = Date.now()): boolean {
  const limit = PER_MINUTE_BUDGET[name];
  if (limit !== undefined && !take(name, limit, now)) return false;
  const appLimit = opts.app ? APP_PER_MINUTE_BUDGET[name] : undefined;
  return appLimit === undefined || take(`app:${name}`, appLimit, now);
}

export function resetBudgets(): void {
  recentCalls.clear();
}
