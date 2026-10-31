import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mayBeStaleKey, TRACK_KEY_VERSION } from '@/lib/keyMigration';
import { JsonAdjacencyStore, readData } from '@/lib/adjacency/store';
import { DEMO_ADJACENCY_PATH } from '@/lib/adjacency/demo';
import { createIngestor } from '@/lib/adjacency/live';
import { readCache } from '@/lib/analysis/previewAnalysis';
import { recordingKeys } from '@/components/recordingKeys';
import { trackKeyOf } from '@/types/track';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'keymig-'));
  process.env.SETARCHITECT_DATA_DIR = root;
});
afterEach(() => {
  delete process.env.SETARCHITECT_DATA_DIR;
});
const inRoot = (name: string) => path.join(root, name);

// Keys exactly as V1's trackKeyOf wrote them: "(Club Mix)" survived as trailing words.
const COLA = 'camelphat|cola';
const COLA_CLUB_V1 = 'camelphat|cola club mix';
const GLUE = 'bicep|glue';
const OPUS = 'eric prydz|opus';
const UNNAMED = 'someone|in da club';

const legacyIndex = () => ({
  version: 1,
  tracklists: { a: 2, b: 2, c: 2 },
  names: {
    [COLA]: { artist: 'CamelPhat', title: 'Cola' },
    [COLA_CLUB_V1]: { artist: 'CamelPhat', title: 'Cola (Club Mix)' },
    [GLUE]: { artist: 'Bicep', title: 'Glue' },
    [OPUS]: { artist: 'Eric Prydz', title: 'Opus' },
  },
  edges: {
    [COLA]: { before: {}, after: { [GLUE]: 2 } },
    [COLA_CLUB_V1]: { before: { [OPUS]: 1 }, after: { [GLUE]: 3, [COLA]: 1, [UNNAMED]: 4 } },
    [GLUE]: { before: { [COLA]: 2, [COLA_CLUB_V1]: 3 }, after: {} },
    [OPUS]: { before: {}, after: { [COLA_CLUB_V1]: 1 } },
    [UNNAMED]: { before: { [COLA_CLUB_V1]: 4 }, after: {} },
  },
  playCounts: { [COLA]: 40, [COLA_CLUB_V1]: 12, [UNNAMED]: 7 },
});

describe('mayBeStaleKey', () => {
  it('flags old keys ending in a qualifier word, which cannot be re-keyed without the title', () => {
    expect(mayBeStaleKey(COLA_CLUB_V1)).toBe(true);
    expect(mayBeStaleKey(UNNAMED)).toBe(true); // "in da club" is ambiguous, so it is dropped, not over-stripped
    expect(mayBeStaleKey(COLA)).toBe(false);
    expect(mayBeStaleKey('x|cola mark knight remix')).toBe(false);
    expect(mayBeStaleKey('x|original')).toBe(false);
  });
});

describe('adjacency index migration', () => {
  it('re-keys named entries ("Cola (Club Mix)" into "Cola"), sums counts, drops unnamed ones, writes back', async () => {
    const file = inRoot('adjacency.json');
    fs.writeFileSync(file, JSON.stringify(legacyIndex()));
    const data = readData(file);

    expect(data.keyVersion).toBe(TRACK_KEY_VERSION);
    expect(Object.keys(data.names).sort()).toEqual([GLUE, COLA, OPUS].sort());
    expect(data.names[COLA]).toEqual({ artist: 'CamelPhat', title: 'Cola' });
    expect(data.edges[COLA].after).toEqual({ [GLUE]: 5 }); // 2 + 3; club->plain became a self-loop; unnamed dropped
    expect(data.edges[COLA].before).toEqual({ [OPUS]: 1 });
    expect(data.edges[GLUE].before).toEqual({ [COLA]: 5 });
    expect(data.edges[OPUS].after).toEqual({ [COLA]: 1 });
    expect(data.edges[UNNAMED]).toBeUndefined();
    expect(data.playCounts).toEqual({ [COLA]: 40 });
    expect(data.tracklists).toEqual({ a: 2, b: 2, c: 2 });

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.keyVersion).toBe(TRACK_KEY_VERSION);
    expect(onDisk.edges[COLA_CLUB_V1]).toBeUndefined();

    const store = new JsonAdjacencyStore(file);
    expect(await store.getNeighbors(trackKeyOf('CamelPhat', 'Cola (Extended)'))).toContainEqual({ trackKey: GLUE, count: 5, direction: 'after' });
  });

  it('is idempotent: a migrated file is not rewritten', () => {
    const file = inRoot('adjacency.json');
    fs.writeFileSync(file, JSON.stringify(legacyIndex()));
    const once = readData(file);
    const mtime = fs.statSync(file).mtimeMs;
    const content = fs.readFileSync(file, 'utf8');
    expect(readData(file)).toEqual(once);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
  });

  it('serves migrated data from a read-only directory without throwing', () => {
    const dir = inRoot('ro');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'adjacency.json');
    fs.writeFileSync(file, JSON.stringify(legacyIndex()));
    fs.chmodSync(dir, 0o555);
    try {
      const data = readData(file);
      expect(data.keyVersion).toBe(TRACK_KEY_VERSION);
      expect(data.edges[COLA].after).toEqual({ [GLUE]: 5 });
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).keyVersion).toBeUndefined();
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('never writes a file outside the runtime data dir (the repo seed is migrated in memory only)', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-like-'));
    const file = path.join(outside, 'adjacency.demo.json');
    fs.writeFileSync(file, JSON.stringify(legacyIndex()));
    const before = fs.readFileSync(file, 'utf8');
    expect(readData(file).keyVersion).toBe(TRACK_KEY_VERSION);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    const seedBefore = fs.readFileSync(DEMO_ADJACENCY_PATH, 'utf8');
    const seedMtime = fs.statSync(DEMO_ADJACENCY_PATH).mtimeMs;
    expect(readData(DEMO_ADJACENCY_PATH).keyVersion).toBe(TRACK_KEY_VERSION);
    expect(fs.readFileSync(DEMO_ADJACENCY_PATH, 'utf8')).toBe(seedBefore);
    expect(fs.statSync(DEMO_ADJACENCY_PATH).mtimeMs).toBe(seedMtime);
  });
});

describe('live-state migration', () => {
  it('drops possibly-stale searched/backoff keys and records the key version', async () => {
    const statePath = inRoot('live-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ searched: { [COLA]: 500, [COLA_CLUB_V1]: 550 }, backoff: { [COLA_CLUB_V1]: 900 } }));
    const fetcher = () => {
      throw new Error('no network in tests');
    };
    // now=600 is within the searched TTL of COLA, so the decision is made without queuing a fetch
    const ing = createIngestor({ statePath, store: new JsonAdjacencyStore(inRoot('adj.json')), fetcher, now: () => 600 } as never);
    expect(await ing.ensureNeighborsFor('CamelPhat', 'Cola (Club Mix)')).toEqual({ digging: false });
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(s.keyVersion).toBe(TRACK_KEY_VERSION);
    expect(s.searched).toEqual({ [COLA]: 500 });
    expect(s.backoff).toEqual({});
  });
});

describe('analysis cache migration', () => {
  it('drops possibly-stale BPM entries once and stores the key version', async () => {
    const file = inRoot('analysis.json');
    fs.writeFileSync(file, JSON.stringify({ [COLA_CLUB_V1]: { bpm: 124 }, [GLUE]: { bpm: 130 } }));
    const cache = await readCache(file);
    expect(cache).toEqual({ [GLUE]: { bpm: 130 } });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).__keyVersion).toBe(TRACK_KEY_VERSION);
    expect(await readCache(file)).toEqual(cache);
  });
});

describe('recordingKeys without a version field (N2)', () => {
  it('reads the version from the title, so an older "Cola (Extended Mix)" is not the original', () => {
    const rec = (t: { title: string; version?: string }) => recordingKeys({ id: 'x', artist: 'CamelPhat', ...t }).find((k) => k.startsWith('rec:'));
    expect(rec({ title: 'Cola (Extended Mix)' })).not.toBe(rec({ title: 'Cola' }));
    expect(rec({ title: 'Cola (Extended Mix)' })).toBe(rec({ title: 'Cola (Extended Mix)', version: 'Extended Mix' }));
  });
});
