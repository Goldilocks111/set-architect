import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { trackKeyOf, type AdjacencyLookup } from '../../types/track';
import { rekeyLegacy, rekeyRecord, TRACK_KEY_VERSION } from '../keyMigration';

export interface TrackRef {
  artist: string;
  title: string;
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
 * Re-keys an index written with an older trackKeyOf. Each key is recomputed from its stored display name
 * (falling back to the key itself); entries that now share a key are merged: edge counts summed per side,
 * edges that became self-loops dropped, play counts by maximum (the same sets were counted under each title).
 */
export function migrateKeys(data: AdjacencyData): AdjacencyData {
  if ((data.keyVersion ?? 1) >= TRACK_KEY_VERSION) return data;
  const memo = new Map<string, string>();
  const rekey = (k: string) => {
    let nk = memo.get(k);
    if (nk === undefined) {
      const n = data.names[k];
      nk = n ? trackKeyOf(n.artist, n.title) : rekeyLegacy(k);
      memo.set(k, nk);
    }
    return nk;
  };
  const names: Record<string, TrackRef> = {};
  for (const [k, n] of Object.entries(data.names)) {
    const nk = rekey(k);
    // keep the display name whose key did not change (the plain title) when several collapse together
    if (!names[nk] || k === nk) names[nk] = n;
  }
  const edges: Record<string, EdgeSides> = {};
  for (const [k, e] of Object.entries(data.edges)) {
    const nk = rekey(k);
    for (const side of ['before', 'after'] as const) {
      for (const [other, count] of Object.entries(e[side])) {
        const no = rekey(other);
        if (no === nk) continue;
        const target = (edges[nk] ??= { before: {}, after: {} });
        target[side][no] = (target[side][no] ?? 0) + count;
      }
    }
  }
  const out: AdjacencyData = { ...data, keyVersion: TRACK_KEY_VERSION, names, edges };
  if (data.playCounts) out.playCounts = rekeyRecord(data.playCounts, Math.max, rekey);
  return out;
}

export function readData(file: string): AdjacencyData {
  if (!existsSync(file)) return emptyData();
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as AdjacencyData;
  if (parsed.version !== 1) throw new Error(`Unsupported adjacency file version in ${file}`);
  const migrated = migrateKeys(parsed);
  if (migrated !== parsed) writeData(file, migrated);
  return migrated;
}

export function writeData(file: string, data: AdjacencyData): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

export class JsonAdjacencyStore implements AdjacencyStore {
  private data: AdjacencyData | undefined;

  constructor(private readonly file: string) {}

  private load(): AdjacencyData {
    return (this.data ??= readData(this.file));
  }

  async hasTracklist(id: string): Promise<boolean> {
    return id in this.load().tracklists;
  }

  async ingest(tracklistId: string, tracks: TrackRef[]): Promise<boolean> {
    const data = this.load();
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
    writeData(this.file, data);
    return true;
  }

  playCountOf(trackKey: string): number | undefined {
    return this.load().playCounts?.[trackKey];
  }

  setPlayCount(trackKey: string, count: number): void {
    const data = this.load();
    (data.playCounts ??= {})[trackKey] = count;
    writeData(this.file, data);
  }

  async getNeighbors(trackKey: string) {
    return neighborsOf(this.load(), trackKey);
  }

  async stats(): Promise<AdjacencyStats> {
    return statsOf(this.load());
  }
}
