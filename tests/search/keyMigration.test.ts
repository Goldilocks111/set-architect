import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rekeyLegacy, TRACK_KEY_VERSION } from '@/lib/keyMigration';
import { JsonAdjacencyStore, readData } from '@/lib/adjacency/store';
import { createIngestor } from '@/lib/adjacency/live';
import { readCache } from '@/lib/analysis/previewAnalysis';
import { trackKeyOf } from '@/types/track';

const tmp = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keymig-')), name);

// Keys exactly as V1's trackKeyOf wrote them: "(Club Mix)" survived as trailing words.
const COLA = 'camelphat|cola';
const COLA_CLUB_V1 = 'camelphat|cola club mix';
const GLUE = 'bicep|glue';
const OPUS = 'eric prydz|opus';

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
    [COLA_CLUB_V1]: { before: { [OPUS]: 1 }, after: { [GLUE]: 3, [COLA]: 1 } },
    [GLUE]: { before: { [COLA]: 2, [COLA_CLUB_V1]: 3 }, after: {} },
    [OPUS]: { before: {}, after: { [COLA_CLUB_V1]: 1 } },
  },
  playCounts: { [COLA]: 40, [COLA_CLUB_V1]: 12 },
});

describe('rekeyLegacy', () => {
  it('maps a V1 key with trailing qualifier words onto the current key, and nothing else', () => {
    expect(rekeyLegacy(COLA_CLUB_V1)).toBe(trackKeyOf('CamelPhat', 'Cola (Club Mix)'));
    expect(rekeyLegacy(COLA_CLUB_V1)).toBe(COLA);
    expect(rekeyLegacy('x|track 2014 remaster')).toBe('x|track');
    expect(rekeyLegacy('x|cola mark knight remix')).toBe('x|cola mark knight remix');
    expect(rekeyLegacy('x|original')).toBe('x|original');
    expect(rekeyLegacy(COLA)).toBe(COLA);
  });
});

describe('adjacency index migration', () => {
  it('re-keys "Cola (Club Mix)" into "Cola", summing edge counts and keeping display names, then writes back', async () => {
    const file = tmp('adjacency.json');
    fs.writeFileSync(file, JSON.stringify(legacyIndex()));
    const data = readData(file);

    expect(data.keyVersion).toBe(TRACK_KEY_VERSION);
    expect(Object.keys(data.names).sort()).toEqual([GLUE, COLA, OPUS].sort());
    expect(data.names[COLA]).toEqual({ artist: 'CamelPhat', title: 'Cola' });
    expect(data.edges[COLA].after).toEqual({ [GLUE]: 5 }); // 2 + 3; the club->plain edge became a self-loop and is dropped
    expect(data.edges[COLA].before).toEqual({ [OPUS]: 1 });
    expect(data.edges[GLUE].before).toEqual({ [COLA]: 5 });
    expect(data.edges[OPUS].after).toEqual({ [COLA]: 1 });
    expect(data.playCounts).toEqual({ [COLA]: 40 });
    expect(data.tracklists).toEqual({ a: 2, b: 2, c: 2 });

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.keyVersion).toBe(TRACK_KEY_VERSION);
    expect(onDisk.edges[COLA_CLUB_V1]).toBeUndefined();

    // the store answers by the current key
    const store = new JsonAdjacencyStore(file);
    const neighbours = await store.getNeighbors(trackKeyOf('CamelPhat', 'Cola (Extended)'));
    expect(neighbours).toContainEqual({ trackKey: GLUE, count: 5, direction: 'after' });
  });

  it('is idempotent: a migrated file is not rewritten', () => {
    const file = tmp('adjacency.json');
    fs.writeFileSync(file, JSON.stringify(legacyIndex()));
    const once = readData(file);
    const mtime = fs.statSync(file).mtimeMs;
    const content = fs.readFileSync(file, 'utf8');
    const twice = readData(file);
    expect(twice).toEqual(once);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
  });
});

describe('live-state migration', () => {
  it('re-keys searched/backoff, keeping the later timestamp, and records the key version', async () => {
    const statePath = tmp('live-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ searched: { [COLA]: 100, [COLA_CLUB_V1]: 500 }, backoff: { [COLA_CLUB_V1]: 900 } }));
    const fetcher = () => {
      throw new Error('no network in tests');
    };
    // now=600 sits inside the migrated backoff (900), so the decision is made without queuing a fetch
    const ing = createIngestor({ statePath, store: new JsonAdjacencyStore(tmp('adj.json')), fetcher, now: () => 600 } as never);
    expect(await ing.ensureNeighborsFor('CamelPhat', 'Cola (Club Mix)')).toEqual({ digging: false });
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(s.keyVersion).toBe(TRACK_KEY_VERSION);
    expect(s.searched).toEqual({ [COLA]: 500 });
    expect(s.backoff).toEqual({ [COLA]: 900 });
  });
});

describe('analysis cache migration', () => {
  it('re-keys the BPM cache once and stores the key version', async () => {
    const file = tmp('analysis.json');
    fs.writeFileSync(file, JSON.stringify({ [COLA_CLUB_V1]: { bpm: 124 }, [GLUE]: { bpm: 130 } }));
    const cache = await readCache(file);
    expect(cache).toEqual({ [COLA]: { bpm: 124 }, [GLUE]: { bpm: 130 } });
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.__keyVersion).toBe(TRACK_KEY_VERSION);
    expect(await readCache(file)).toEqual(cache);
  });
});
