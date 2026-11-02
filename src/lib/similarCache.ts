import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './dataDir';
import type { SimilarItem } from './sources/lastfm';

/** Similar-track answers per trackKey, kept 24 h (empty answers too): a set refresh re-asks the same 3 seeds. */
export const SIMILAR_TTL_MS = 24 * 3600_000;
/** A fallback answer given while Last.fm was cooling down or failing: kept briefly so Last.fm gets asked again soon. */
export const SIMILAR_FALLBACK_TTL_MS = 3600_000;

type Entry = { items: SimilarItem[]; at: number; ttl?: number };
const fresh = (e: Entry, now: number) => now - e.at < (e.ttl ?? SIMILAR_TTL_MS);

const file = () => dataDir('index', 'similar.json');

function read(): Record<string, Entry> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, Entry>) : {};
  } catch {
    return {}; // missing or corrupt: start empty
  }
}

/** Parsed once, re-read only when the file's mtime, size or inode changed (as metadataCache does). */
let snap: { path: string; mtimeMs: number; size: number; ino: number; data: Record<string, Entry> } | undefined;

function snapshot(): Record<string, Entry> {
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

export function getSimilarCached(key: string, now = Date.now()): SimilarItem[] | undefined {
  const data = snapshot();
  const e = Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
  return e && Array.isArray(e.items) && fresh(e, now) ? e.items : undefined;
}

/** Atomic write (tmp + rename); expired entries are dropped so the file stays small. */
export function putSimilar(key: string, items: SimilarItem[], opts: { ttlMs?: number; now?: number } = {}): void {
  const now = opts.now ?? Date.now();
  const data = read();
  for (const [k, e] of Object.entries(data)) if (!fresh(e, now)) delete data[k];
  data[key] = { items, at: now, ...(opts.ttlMs !== undefined ? { ttl: opts.ttlMs } : {}) };
  snap = undefined;
  try {
    const f = file();
    const tmp = `${f}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, f);
  } catch {
    // best-effort (read-only filesystems)
  }
}
