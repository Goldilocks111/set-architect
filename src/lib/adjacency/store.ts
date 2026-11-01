import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { trackKeyOf, type AdjacencyLookup } from '../../types/track';
import { isRuntimeDataPath } from '../dataDir';
import { TRACK_KEY_VERSION } from '../keyMigration';

export interface TrackRef {
  artist: string;
  title: string;
}

export interface TrackSummary extends TrackRef {
  trackKey: string;
  neighborCount: number;
}

export interface AdjacencyStats {
  tracklistCount: number;
  trackCount: number;
  /** Distinct directed pairs (a followed by b). */
  pairCount: number;
}

/** Storage seam: the JSON file store below can be swapped for a Supabase-backed one. */
export interface AdjacencyStore extends AdjacencyLookup {
  hasTracklist(id: string): Promise<boolean>;
  /** Ingest an ordered tracklist. Returns false (and changes nothing) if the id was already ingested. */
  ingest(tracklistId: string, tracks: TrackRef[]): Promise<boolean>;
  stats(): Promise<AdjacencyStats>;
}

interface EdgeSides {
  before: Record<string, number>;
  after: Record<string, number>;
}

export interface AdjacencyData {
  version: 1;
  /** trackKeyOf normalization the keys were written with (absent = 1); see keyMigration.ts. */
  keyVersion?: number;
  tracklists: Record<string, number>; // id -> track count
  names: Record<string, TrackRef>; // trackKey -> display artist/title
  edges: Record<string, EdgeSides>; // trackKey -> neighbors by side
  /** trackKey -> number of 1001TL sets containing the track (from the ajax track search). */
  playCounts?: Record<string, number>;
}

export const emptyData = (): AdjacencyData => ({ version: 1, keyVersion: TRACK_KEY_VERSION, tracklists: {}, names: {}, edges: {} });

export function addEdge(data: AdjacencyData, from: string, to: string, count = 1): void {
  const bump = (key: string, side: keyof EdgeSides, other: string) => {
    const e = (data.edges[key] ??= { before: {}, after: {} });
    e[side][other] = (e[side][other] ?? 0) + count;
  };
  bump(from, 'after', to);
  bump(to, 'before', from);
}

export function neighborsOf(data: AdjacencyData, trackKey: string) {
  const e = data.edges[trackKey];
  if (!e) return [];
  const out: Array<{ trackKey: string; count: number; direction: 'before' | 'after' }> = [];
  for (const [key, count] of Object.entries(e.before)) out.push({ trackKey: key, count, direction: 'before' });
  for (const [key, count] of Object.entries(e.after)) out.push({ trackKey: key, count, direction: 'after' });
  return out;
}

export function statsOf(data: AdjacencyData): AdjacencyStats {
  let pairCount = 0;
  for (const e of Object.values(data.edges)) pairCount += Object.keys(e.after).length;
  return {
    tracklistCount: Object.keys(data.tracklists).length,
    trackCount: Object.keys(data.edges).length,
    pairCount,
  };
}

/**
 * Re-keys an index written with an older trackKeyOf. Each key is recomputed from its stored display name;
 * entries without one cannot be re-keyed safely and are dropped (they are rebuilt by the next dig). Entries
 * that now share a key are merged: edge counts summed per side, edges that became self-loops dropped, play
 * counts by maximum (the same sets were counted under each title).
 */
export function migrateKeys(data: AdjacencyData): AdjacencyData {
  if ((data.keyVersion ?? 1) >= TRACK_KEY_VERSION) return data;
  const rekey = (k: string): string | undefined => {
    const n = data.names[k];
    return n ? trackKeyOf(n.artist, n.title) : undefined;
  };
  const names: Record<string, TrackRef> = {};
  for (const [k, n] of Object.entries(data.names)) {
    const nk = rekey(k)!;
    // keep the display name whose key did not change (the plain title) when several collapse together
    if (!names[nk] || k === nk) names[nk] = n;
  }
  const edges: Record<string, EdgeSides> = {};
  for (const [k, e] of Object.entries(data.edges)) {
    const nk = rekey(k);
    if (!nk) continue;
    for (const side of ['before', 'after'] as const) {
      for (const [other, count] of Object.entries(e[side])) {
        const no = rekey(other);
        if (!no || no === nk) continue;
        const target = (edges[nk] ??= { before: {}, after: {} });
        target[side][no] = (target[side][no] ?? 0) + count;
      }
    }
  }
  const out: AdjacencyData = { ...data, keyVersion: TRACK_KEY_VERSION, names, edges };
  if (data.playCounts) {
    const playCounts: Record<string, number> = {};
    for (const [k, c] of Object.entries(data.playCounts)) {
      const nk = rekey(k);
      if (nk) playCounts[nk] = Math.max(playCounts[nk] ?? 0, c);
    }
    out.playCounts = playCounts;
  }
  return out;
}

export function readData(file: string): AdjacencyData {
  if (!existsSync(file)) return emptyData();
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as AdjacencyData;
  if (parsed.version !== 1) throw new Error(`Unsupported adjacency file version in ${file}`);
  const migrated = migrateKeys(parsed);
  // Persist the migration only for runtime files: a file inside the repo (the demo seed) is migrated in
  // memory, since writing it would dirty git and loop the dev server; a read-only host must still read.
  if (migrated !== parsed && isRuntimeDataPath(file)) {
    try {
      writeData(file, migrated);
    } catch {
      // best-effort: the migrated data is served either way and the write is retried on the next load
    }
  }
  return migrated;
}

export function writeData(file: string, data: AdjacencyData): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

const DEFAULT_RECHECK_MS = 3000;

/**
 * Several processes (dev server, ingest driver) may share one file. The cache is revalidated against the
 * file's identity (inode/mtime/size, so atomic renames are noticed): reads at most every `recheckMs`,
 * mutations always, and a mutation is applied to the fresh copy before the atomic write.
 */
export class JsonAdjacencyStore implements AdjacencyStore {
  private data: AdjacencyData | undefined;
  private sig: string | undefined;
  private checkedAt = 0;

  constructor(
    private readonly file: string,
    private readonly opts: { recheckMs?: number } = {}
  ) {}

  private signature(): string {
    try {
      const st = statSync(this.file);
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return 'missing';
    }
  }

  private load(forWrite = false): AdjacencyData {
    const t = Date.now();
    if (this.data && !forWrite && t - this.checkedAt < (this.opts.recheckMs ?? DEFAULT_RECHECK_MS)) return this.data;
    const sig = this.signature();
    if (!this.data || sig !== this.sig) {
      this.data = readData(this.file);
      this.sig = this.signature(); // after readData, which may persist a migration
    }
    this.checkedAt = t;
    return this.data;
  }

  private save(data: AdjacencyData): void {
    writeData(this.file, data);
    this.sig = this.signature();
    this.checkedAt = Date.now();
  }

  async hasTracklist(id: string): Promise<boolean> {
    return id in this.load().tracklists;
  }

  async ingest(tracklistId: string, tracks: TrackRef[]): Promise<boolean> {
    const data = this.load(true);
    if (tracklistId in data.tracklists) return false;
    const keys = tracks.map((t) => {
      const key = trackKeyOf(t.artist, t.title);
      data.names[key] ??= { artist: t.artist, title: t.title };
      return key;
    });
    for (let i = 1; i < keys.length; i++) {
      if (keys[i] !== keys[i - 1]) addEdge(data, keys[i - 1], keys[i]);
    }
    data.tracklists[tracklistId] = keys.length;
    this.save(data);
    return true;
  }

  playCountOf(trackKey: string): number | undefined {
    return this.load().playCounts?.[trackKey];
  }

  setPlayCount(trackKey: string, count: number): void {
    const data = this.load(true);
    (data.playCounts ??= {})[trackKey] = count;
    this.save(data);
  }

  /** Every indexed track with its display name and distinct-neighbor count (driver frontier). */
  trackSummaries(): TrackSummary[] {
    const data = this.load();
    const out: TrackSummary[] = [];
    for (const [trackKey, name] of Object.entries(data.names)) {
      out.push({ trackKey, artist: name.artist, title: name.title, neighborCount: neighborsOf(data, trackKey).length });
    }
    return out;
  }

  async getNeighbors(trackKey: string) {
    return neighborsOf(this.load(), trackKey);
  }

  async stats(): Promise<AdjacencyStats> {
    return statsOf(this.load());
  }
}
