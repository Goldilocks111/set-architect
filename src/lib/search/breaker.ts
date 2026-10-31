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

// Persisted so a server restart does not walk straight back into a provider's lockout.
let until: Record<string, number> | null = null;
const streaks = new Map<string, number>();

const file = () => dataDir('search', 'provider-cooldowns.json');

function load(): Record<string, number> {
  if (until) return until;
  try {
    until = JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, number>;
  } catch {
    until = {};
  }
  return until;
}

function open(name: Name, ms: number, now: number): void {
  const state = load();
  state[name] = Math.max(state[name] ?? 0, now + Math.min(ms, MAX_COOLDOWN_MS));
  streaks.delete(name);
  try {
    fs.writeFileSync(file(), JSON.stringify(state));
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

export function recordFailure(name: Name, err: unknown, now = Date.now()): void {
  if (!(err instanceof HttpError)) return;
  if (err.status === 429) return open(name, err.retryAfterMs ?? THROTTLE_COOLDOWN_MS, now);
  // Apple signals its rate limit with a bare 403.
  if (name === 'itunes' && err.status === 403) return open(name, err.retryAfterMs ?? THROTTLE_COOLDOWN_MS, now);
  // MusicBrainz answers 503 when a client exceeds 1 req/s.
  if (name === 'musicbrainz' && err.status === 503) return open(name, Math.max(err.retryAfterMs ?? 0, MB_BACKOFF_MS), now);
  if (err.status === 403 || err.status >= 500) {
    const n = (streaks.get(name) ?? 0) + 1;
    if (n >= FAILURE_STREAK) open(name, STREAK_COOLDOWN_MS, now);
    else streaks.set(name, n);
  }
}

export function resetBreakers(): void {
  until = null;
  streaks.clear();
  try {
    fs.rmSync(file(), { force: true });
  } catch {
    // nothing persisted
  }
}
