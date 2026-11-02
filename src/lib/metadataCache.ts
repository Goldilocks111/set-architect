import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './dataDir';
import { ESSENTIALS, missingEssentials, withDanceabilityPrior, type Essential, type IncompleteReason } from './completeness';
import type { Track } from '@/types/track';

/** What a manual write may carry: the essentials plus the track length (non-essential, but a MIK file has it). */
export type ManualFields = Partial<Pick<Track, Essential | 'durationMs'>>;

export interface CacheEntry {
  fields: Partial<Track>;
  sources: Record<string, string>;
  resolvedAt: number;
  attempts: number;
  reason?: IncompleteReason;
  retryAt?: number;
  /** When Last.fm last answered with no genre tags for this track: not asked again for STYLES_RECHECK_MS. */
  stylesCheckedAt?: number;
  /** The first provider match's own spelling of artist/title (Deezer, else Spotify): the canonical name to show. */
  display?: { artist: string; title: string };
}

const file = () => dataDir('index', 'metadata.json');
// previewUrl expires within minutes; id/sources/unresolved are derived, not data.
const SKIP = new Set(['id', 'sources', 'unresolved', 'previewUrl']);

function read(): Record<string, CacheEntry> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, CacheEntry>) : {};
  } catch {
    return {}; // missing or corrupt: start empty
  }
}

/**
 * Read-only snapshot for lookups, re-read only when the file's mtime, size or inode changed (or after our own write).
 * Writers keep using read() so they never mutate what lookups share.
 */
let snap: { path: string; mtimeMs: number; size: number; ino: number; data: Record<string, CacheEntry> } | undefined;

function snapshot(): Record<string, CacheEntry> {
  const f = file();
  let st: fs.Stats;
  try {
    st = fs.statSync(f);
  } catch {
    snap = undefined;
    return {};
  }
  if (snap && snap.path === f && snap.mtimeMs === st.mtimeMs && snap.size === st.size && snap.ino === st.ino) return snap.data;
  const data = read();
  snap = { path: f, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, data };
  return data;
}

function write(cache: Record<string, CacheEntry>): void {
  snap = undefined;
  try {
    const f = file();
    const tmp = `${f}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, f);
  } catch {
    // best-effort (read-only filesystems)
  }
}

export function getEntry(key: string): CacheEntry | undefined {
  return snapshot()[key];
}

/** Many lookups against one snapshot: the cache file is parsed at most once for the whole list. */
export function getEntries(keys: string[]): Map<string, CacheEntry> {
  const data = snapshot();
  const out = new Map<string, CacheEntry>();
  for (const k of keys) {
    const e = Object.prototype.hasOwnProperty.call(data, k) ? data[k] : undefined;
    if (e) out.set(k, e);
  }
  return out;
}

const asTrack = (fields: Partial<Track>): Track => ({ id: '', artist: '', title: '', sources: {}, ...fields });

/** Fills danceability from energy when it is missing (see danceabilityPrior); true when it changed the entry. */
function fillPrior(e: CacheEntry): boolean {
  const t = asTrack(e.fields);
  const filled = withDanceabilityPrior({ ...t, sources: e.sources });
  if (filled === t || filled.danceability === undefined) return false;
  e.fields.danceability = filled.danceability;
  e.sources.danceability = filled.sources.danceability;
  return true;
}

/** Re-derives reason from the merged fields: a complete entry carries none. */
function settle(e: CacheEntry, reason?: IncompleteReason): void {
  if (missingEssentials(asTrack(e.fields)).length === 0) {
    delete e.reason;
    delete e.retryAt;
  } else if (reason) e.reason = reason;
}

export function putResolved(key: string, track: Track, now = Date.now(), display?: { artist: string; title: string }): CacheEntry {
  const cache = read();
  const prev = cache[key];
  const entry: CacheEntry = {
    fields: { ...prev?.fields },
    sources: { ...prev?.sources },
    resolvedAt: now,
    attempts: (prev?.attempts ?? 0) + 1,
    reason: prev?.reason,
    retryAt: prev?.retryAt,
  };
  const shown = prev?.display ?? display; // first provider match wins
  if (shown) entry.display = shown;
  for (const [field, value] of Object.entries(track)) {
    if (SKIP.has(field) || value === undefined || value === null) continue;
    if (entry.sources[field] === 'manual') continue;
    (entry.fields as Record<string, unknown>)[field] = value;
    entry.sources[field] = track.sources[field] ?? entry.sources[field] ?? 'unknown';
  }
  delete entry.reason;
  settle(entry, track.unresolved?.reason);
  cache[key] = entry;
  write(cache);
  return entry;
}

function applyManual(cache: Record<string, CacheEntry>, key: string, fields: ManualFields): CacheEntry {
  const prev = cache[key];
  const entry: CacheEntry = {
    fields: { ...prev?.fields },
    sources: { ...prev?.sources },
    resolvedAt: prev?.resolvedAt ?? Date.now(),
    attempts: prev?.attempts ?? 0,
    reason: prev?.reason,
    retryAt: prev?.retryAt,
    ...(prev?.display ? { display: prev.display } : {}),
  };
  for (const f of [...ESSENTIALS, 'durationMs'] as const) {
    const v = fields[f];
    if (v === undefined) continue;
    (entry.fields as Record<string, unknown>)[f] = v;
    entry.sources[f] = 'manual';
  }
  fillPrior(entry); // a MIK/manual row with energy is complete without asking any provider for danceability
  settle(entry);
  cache[key] = entry;
  return entry;
}

export function putManual(key: string, fields: ManualFields): CacheEntry {
  const cache = read();
  const entry = applyManual(cache, key, fields);
  write(cache);
  return entry;
}

/** Batch form of putManual: one read and one atomic write for the whole list (later items win on a repeated key). */
export function putManualMany(items: Array<{ key: string; fields: ManualFields }>): CacheEntry[] {
  const cache = read();
  const entries = items.map(({ key, fields }) => applyManual(cache, key, fields));
  if (items.length) write(cache);
  return entries;
}

/** Resolution is done for this track: fill the danceability prior if it applies and persist it. */
export function putPrior(key: string): CacheEntry | undefined {
  const cache = read();
  const e = cache[key];
  if (!e || !fillPrior(e)) return e;
  settle(e);
  write(cache);
  return e;
}

export const STYLES_RECHECK_MS = 7 * 24 * 3600_000;

/** True when styles are known, or Last.fm found none recently: no need to ask. */
export function stylesSettled(e: CacheEntry, now = Date.now()): boolean {
  if (e.sources.styles === 'manual' || e.fields.styles?.length) return true;
  return e.stylesCheckedAt !== undefined && now - e.stylesCheckedAt < STYLES_RECHECK_MS;
}

/** Stores the lanes found for a track (none → the "no styles" marker). Needs an existing entry. */
export function putStyles(key: string, styles: string[], now = Date.now()): CacheEntry | undefined {
  const cache = read();
  const e = cache[key];
  if (!e || e.sources.styles === 'manual') return e;
  if (styles.length) {
    e.fields.styles = styles;
    e.sources.styles = 'lastfm-tags';
    delete e.stylesCheckedAt;
  } else e.stylesCheckedAt = now;
  write(cache);
  return e;
}

/** Stores the provider's display name for an existing entry that has none (first match wins). */
export function putDisplay(key: string, display: { artist: string; title: string }): void {
  const cache = read();
  const e = cache[key];
  if (!e || e.display) return;
  e.display = display;
  write(cache);
}

/** Records (or clears) when the re-resolve queue will next try this track. */
export function setRetry(key: string, retryAt: number | undefined): void {
  const cache = read();
  const e = cache[key];
  if (!e) return;
  if (retryAt === undefined) delete e.retryAt;
  else e.retryAt = retryAt;
  write(cache);
}
