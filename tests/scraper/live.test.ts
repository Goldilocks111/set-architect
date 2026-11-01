// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FetchError, type Fetcher } from '../../scripts/scraper/fetchPage';
import { BACKOFF_MS, QUEUE_PAUSE_MS, SOFT_PAUSE_MS, SEARCHED_TTL_MS, createIngestor, parsePlayCount } from '../../src/lib/adjacency/live';
import { JsonAdjacencyStore } from '../../src/lib/adjacency/store';
import { trackKeyOf } from '../../src/types/track';

const fx = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const AJAX = JSON.stringify({
  success: true,
  data: {
    '1': { properties: { trackname: 'Glue', fulltrackname: 'Bicep - Glue', play_count: 321, artists: [{ properties: { artistname: 'Bicep' } }] } },
  },
});

let dir: string;
let clock: number;
let statePath: string;
let store: JsonAdjacencyStore;
let active: number;
let maxActive: number;
let calls: string[];
let failWith: (() => Error) | undefined;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const fetcher: Fetcher = {
  async search(q) {
    calls.push(`search:${q}`);
    active++;
    maxActive = Math.max(maxActive, active);
    await tick();
    active--;
    if (failWith) throw failWith();
    return fx('search.sample.html');
  },
  async get(url) {
    calls.push(`get:${url}`);
    active++;
    maxActive = Math.max(maxActive, active);
    await tick();
    active--;
    if (failWith) throw failWith();
    return url.includes('/ajax/') ? AJAX : fx('tracklist.sample.html');
  },
};

const make = () => createIngestor({ fetcher, store, statePath, now: () => clock });
const state = () => JSON.parse(readFileSync(statePath, 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'live-'));
  statePath = path.join(dir, 'live-state.json');
  store = new JsonAdjacencyStore(path.join(dir, 'adjacency.json'));
  clock = 1_000_000_000;
  active = 0;
  maxActive = 0;
  calls = [];
  failWith = undefined;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('live ingestor', () => {
  it('ingests the top tracklists, stores play_count and marks the key searched', async () => {
    const live = make();
    expect(await live.ensureNeighborsFor('Bicep', 'Glue')).toEqual({ digging: true });
    await live.whenIdle();
    expect(calls[0]).toBe('search:Bicep Glue');
    expect(calls.filter((c) => c.startsWith('get:') && c.includes('/tracklist/'))).toHaveLength(3);
    expect(await store.hasTracklist('9ycgytk')).toBe(true);
    expect(store.playCountOf(trackKeyOf('Bicep', 'Glue'))).toBe(321);
    expect(state().searched[trackKeyOf('Bicep', 'Glue')]).toBe(clock);
    expect(live.isDigging('Bicep', 'Glue')).toBe(false);
  });

  it('dedupes by trackKey and processes one job at a time', async () => {
    const live = make();
    const first = await live.ensureNeighborsFor('Bicep', 'Glue');
    const again = await live.ensureNeighborsFor('BICEP', 'glue');
    await live.ensureNeighborsFor('Other', 'Track');
    expect(first.digging && again.digging).toBe(true);
    await live.whenIdle();
    expect(calls.filter((c) => c.startsWith('search:'))).toEqual(['search:Bicep Glue', 'search:Other Track']);
    expect(maxActive).toBe(1);
  });

  it('does nothing when the index already has neighbors', async () => {
    await store.ingest('x', [
      { artist: 'Bicep', title: 'Glue' },
      { artist: 'A', title: 'B' },
    ]);
    const live = make();
    expect(await live.ensureNeighborsFor('Bicep', 'Glue')).toEqual({ digging: false });
    expect(calls).toEqual([]);
  });

  it('honors the 7-day searched marker, then re-searches once it is stale', async () => {
    const key = trackKeyOf('Nobody', 'Known');
    writeFileSync(statePath, JSON.stringify({ searched: { [key]: clock - 1000 }, backoff: {} }));
    const live = make();
    expect(await live.ensureNeighborsFor('Nobody', 'Known')).toEqual({ digging: false });
    clock += SEARCHED_TTL_MS;
    expect(await live.ensureNeighborsFor('Nobody', 'Known')).toEqual({ digging: true });
    await live.whenIdle();
  });

  it('on 429 backs the key off for 24h and stops the whole queue for 30 minutes', async () => {
    failWith = () => new FetchError(429, 'https://www.1001tracklists.com/x');
    const live = make();
    await live.ensureNeighborsFor('Bicep', 'Glue');
    await live.ensureNeighborsFor('Other', 'Track');
    await live.whenIdle();
    expect(calls.filter((c) => c.startsWith('search:'))).toEqual(['search:Bicep Glue']);
    const s = state();
    expect(s.backoff[trackKeyOf('Bicep', 'Glue')]).toBe(clock + BACKOFF_MS);
    expect(s.pausedUntil).toBe(clock + QUEUE_PAUSE_MS);
    expect(live.isDigging('Other', 'Track')).toBe(false);

    failWith = undefined;
    calls = [];
    expect(await live.ensureNeighborsFor('Third', 'One')).toEqual({ digging: false });
    clock += QUEUE_PAUSE_MS + 1;
    expect(await live.ensureNeighborsFor('Third', 'One')).toEqual({ digging: true });
    expect(await live.ensureNeighborsFor('Bicep', 'Glue')).toEqual({ digging: false }); // still in 24h backoff
    await live.whenIdle();
  });

  it('a non-block failure backs off only that key and keeps the queue running', async () => {
    let n = 0;
    const flaky: Fetcher = {
      ...fetcher,
      async search(q) {
        if (n++ === 0) throw new Error('boom');
        return fetcher.search(q);
      },
    };
    const live = createIngestor({ fetcher: flaky, store, statePath, now: () => clock });
    await live.ensureNeighborsFor('A', 'One');
    await live.ensureNeighborsFor('B', 'Two');
    await live.whenIdle();
    const s = state();
    expect(s.backoff[trackKeyOf('A', 'One')]).toBe(clock + BACKOFF_MS);
    expect(s.pausedUntil).toBeUndefined();
    expect(s.searched[trackKeyOf('B', 'Two')]).toBe(clock);
  });

  it('never fetches /track/ pages', async () => {
    const live = make();
    await live.ensureNeighborsFor('Bicep', 'Glue');
    await live.whenIdle();
    expect(calls.some((c) => /\/track\//.test(c))).toBe(false);
    expect(existsSync(statePath)).toBe(true);
  });
});

describe('parsePlayCount', () => {
  it('matches the seed track by artist+title and ignores unrelated hits', () => {
    expect(parsePlayCount(AJAX, 'Bicep', 'Glue')).toBe(321);
    expect(parsePlayCount(AJAX, 'Someone', 'Else')).toBeUndefined();
    expect(parsePlayCount('not json', 'Bicep', 'Glue')).toBeUndefined();
  });
});

describe('partial failures', () => {
  it('skips a tracklist that fails with a non-block error and still finishes the job', async () => {
    let tl = 0;
    const f: Fetcher = {
      ...fetcher,
      async get(url) {
        if (url.includes('/tracklist/') && tl++ === 0) throw new FetchError(500, url);
        return fetcher.get(url);
      },
    };
    const live = createIngestor({ fetcher: f, store, statePath, now: () => clock });
    await live.ensureNeighborsFor('Bicep', 'Glue');
    await live.whenIdle();
    expect(state().searched[trackKeyOf('Bicep', 'Glue')]).toBe(clock);
    expect(await store.hasTracklist('9ycgytk')).toBe(true);
  });
});

describe('206 soft block', () => {
  const soft = () => new FetchError(206, 'https://www.1001tracklists.com/tracklist/x/y.html');

  it('aborts the job, pauses the queue 60 minutes and does not mark the key searched', async () => {
    let tl = 0;
    const f: Fetcher = {
      ...fetcher,
      async get(url) {
        if (url.includes('/tracklist/') && tl++ === 1) throw soft();
        return fetcher.get(url);
      },
    };
    const live = createIngestor({ fetcher: f, store, statePath, now: () => clock });
    await live.ensureNeighborsFor('Bicep', 'Glue');
    await live.ensureNeighborsFor('Other', 'Track');
    await live.whenIdle();
    const s = state();
    expect(s.pausedUntil).toBe(clock + SOFT_PAUSE_MS);
    expect(s.searched[trackKeyOf('Bicep', 'Glue')]).toBeUndefined();
    expect(s.backoff[trackKeyOf('Bicep', 'Glue')]).toBeUndefined();
    expect(calls.filter((c) => c.includes('/tracklist/'))).toHaveLength(1); // second one threw (unrecorded); third never fetched
    expect(calls.filter((c) => c.startsWith('search:'))).toHaveLength(1);
    expect(await live.ensureNeighborsFor('Bicep', 'Glue')).toEqual({ digging: false });
  });

  it('a job that ingests zero tracklists is not marked searched and retries only after the backoff', async () => {
    const f: Fetcher = {
      ...fetcher,
      async get(url) {
        if (url.includes('/tracklist/')) throw new FetchError(500, url);
        return fetcher.get(url);
      },
    };
    const live = createIngestor({ fetcher: f, store, statePath, now: () => clock });
    await live.ensureNeighborsFor('Bicep', 'Glue');
    await live.whenIdle();
    expect(state().searched[trackKeyOf('Bicep', 'Glue')]).toBeUndefined();
    expect(await live.ensureNeighborsFor('Bicep', 'Glue')).toEqual({ digging: false });
    clock += BACKOFF_MS;
    expect(await live.ensureNeighborsFor('Bicep', 'Glue')).toEqual({ digging: true });
    await live.whenIdle();
  });

  it('runs the first job after a cool-down at double delay, then restores normal pacing', async () => {
    writeFileSync(statePath, JSON.stringify({ searched: {}, backoff: {}, pausedUntil: clock - 1 }));
    const scales: number[] = [];
    const f: Fetcher = { ...fetcher, setDelayScale: (n) => void scales.push(n) };
    const live = createIngestor({ fetcher: f, store, statePath, now: () => clock });
    await live.ensureNeighborsFor('Bicep', 'Glue');
    await live.whenIdle();
    await live.ensureNeighborsFor('Other', 'Track');
    await live.whenIdle();
    expect(scales).toEqual([2, 1, 1, 1]);
    expect(state().pausedUntil).toBeUndefined();
  });

  it('an incomplete job (tracklists found, every page failed) backs the key off instead of retrying forever', async () => {
    const broken: Fetcher = {
      search: (q) => fetcher.search(q),
      async get(url) {
        if (url.includes('/ajax/')) return AJAX;
        throw new Error('parse failure');
      },
    };
    const live = createIngestor({ fetcher: broken, store, statePath, now: () => clock });
    await live.ensureNeighborsFor('Bicep', 'Glue');
    await live.whenIdle();
    const key = trackKeyOf('Bicep', 'Glue');
    expect(state().backoff[key]).toBe(clock + BACKOFF_MS);
    calls = [];
    expect(await live.ensureNeighborsFor('Bicep', 'Glue')).toEqual({ digging: false });
    expect(calls).toEqual([]);
  });

  it('deepen digs a track that already has neighbors; the default does not', async () => {
    await store.ingest('x', [
      { artist: 'Bicep', title: 'Glue' },
      { artist: 'A', title: 'B' },
    ]);
    const live = make();
    expect(await live.ensureNeighborsFor('Bicep', 'Glue')).toEqual({ digging: false });
    expect(await live.ensureNeighborsFor('Bicep', 'Glue', { deepen: true })).toEqual({ digging: true });
    await live.whenIdle();
    expect(calls[0]).toBe('search:Bicep Glue');
  });
});
