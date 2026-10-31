import fs from 'node:fs';
import { dataDir } from '@/lib/dataDir';
import { fold, mergedSearch } from './merge';
import type { MergedSearchResponse } from './types';

export const CACHE_TTL_MS = 24 * 3600_000;
/** A response missing a provider is kept only briefly, so the full answer replaces it soon. */
export const DEGRADED_TTL_MS = 5 * 60_000;
export const CACHE_MAX_ENTRIES = 300;
const MAX_HITS_PER_ENTRY = 30;
const WRITE_DELAY_MS = 1000;

interface Entry {
  at: number;
  ttl: number;
  value: MergedSearchResponse;
}

// Insertion-ordered: the first key is the oldest, evicted first.
let entries: Map<string, Entry> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

const file = () => dataDir('search', 'query-cache.json');

function load(): Map<string, Entry> {
  if (entries) return entries;
  entries = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Array<[string, Entry]>;
    for (const [k, e] of raw) entries.set(k, e);
  } catch {
    // no cache yet
  }
  return entries;
}

function persistSoon(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.writeFileSync(file(), JSON.stringify([...load()]));
    } catch {
      // best-effort
    }
  }, WRITE_DELAY_MS);
  writeTimer.unref?.();
}

export const cacheKey = (query: string) => fold(query);

/** Preview URLs are short-lived (Deezer's are signed for minutes) and must not be persisted. */
function storable(res: MergedSearchResponse): MergedSearchResponse {
  return {
    degraded: res.degraded,
    hits: res.hits.slice(0, MAX_HITS_PER_ENTRY).map(({ previewUrl: _drop, ...h }) => h),
  };
}

/**
 * mergedSearch behind a 24h cache keyed by the normalized query, so a user retyping or
 * re-running the same search does not spend provider quota.
 */
export async function cachedMergedSearch(
  query: string,
  search: (q: string) => Promise<MergedSearchResponse> = mergedSearch,
  now = Date.now()
): Promise<MergedSearchResponse> {
  const key = cacheKey(query);
  const map = load();
  const hit = map.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value;

  const res = await search(query);
  if (key && !(res.hits.length === 0 && res.degraded.length)) {
    map.delete(key);
    map.set(key, { at: now, ttl: res.degraded.length ? DEGRADED_TTL_MS : CACHE_TTL_MS, value: storable(res) });
    while (map.size > CACHE_MAX_ENTRIES) map.delete(map.keys().next().value!);
    persistSoon();
  }
  return res;
}

export function clearSearchCache(): void {
  entries = new Map();
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  try {
    fs.rmSync(file(), { force: true });
  } catch {
    // nothing persisted
  }
}

/** Test hook: write pending changes now. */
export function flushSearchCache(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  fs.writeFileSync(file(), JSON.stringify([...load()]));
}
