import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './dataDir';
import { ESSENTIALS, missingEssentials, type Essential, type IncompleteReason } from './completeness';
import type { Track } from '@/types/track';

export interface CacheEntry {
  fields: Partial<Track>;
  sources: Record<string, string>;
  resolvedAt: number;
  attempts: number;
  reason?: IncompleteReason;
  retryAt?: number;
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

function write(cache: Record<string, CacheEntry>): void {
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
  return read()[key];
}

const asTrack = (fields: Partial<Track>): Track => ({ id: '', artist: '', title: '', sources: {}, ...fields });

/** Re-derives reason from the merged fields: a complete entry carries none. */
function settle(e: CacheEntry, reason?: IncompleteReason): void {
  if (missingEssentials(asTrack(e.fields)).length === 0) {
    delete e.reason;
    delete e.retryAt;
  } else if (reason) e.reason = reason;
}

export function putResolved(key: string, track: Track, now = Date.now()): CacheEntry {
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

export function putManual(key: string, fields: Partial<Pick<Track, Essential>>): CacheEntry {
  const cache = read();
  const prev = cache[key];
  const entry: CacheEntry = {
    fields: { ...prev?.fields },
    sources: { ...prev?.sources },
    resolvedAt: prev?.resolvedAt ?? Date.now(),
    attempts: prev?.attempts ?? 0,
    reason: prev?.reason,
    retryAt: prev?.retryAt,
  };
  for (const f of ESSENTIALS) {
    const v = fields[f];
    if (v === undefined) continue;
    (entry.fields as Record<string, unknown>)[f] = v;
    entry.sources[f] = 'manual';
  }
  settle(entry);
  cache[key] = entry;
  write(cache);
  return entry;
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
