// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock, isLockHeld, releaseLock } from '../../scripts/ingest/lock';
import { nextSeeds, runDriver } from '../../scripts/ingest/run';
import { trackKeyOf } from '../../src/types/track';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ingest-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const summary = (artist: string, title: string, neighborCount: number) => ({ trackKey: trackKeyOf(artist, title), artist, title, neighborCount });
const emptyState = { searched: {}, backoff: {} };

describe('nextSeeds', () => {
  it('lists seeds first, then indexed tracks by descending neighbor count, skipping searched/backed-off keys', () => {
    const store = { trackSummaries: () => [summary('B', 'Low', 1), summary('A', 'High', 9), summary('C', 'Done', 20), summary('D', 'Off', 30)] };
    const state = {
      searched: { [trackKeyOf('C', 'Done')]: Date.now() },
      backoff: { [trackKeyOf('D', 'Off')]: Date.now() + 1e6 },
    };
    const seeds = [{ artist: 'S', title: 'Seed' }, { artist: 'C', title: 'Done' }];
    const out = nextSeeds(store, state, 10, seeds, Date.now());
    expect(out).toEqual([
      { artist: 'S', title: 'Seed' },
      { artist: 'A', title: 'High' },
      { artist: 'B', title: 'Low' },
    ]);
    expect(nextSeeds(store, state, 2, seeds, Date.now())).toHaveLength(2);
  });
});

describe('lock', () => {
  it('refuses a live holder and takes over a stale one', () => {
    const file = path.join(dir, 'ingest.lock');
    expect(acquireLock(file, { pid: 111, isAlive: () => true })).toBe(true);
    expect(acquireLock(file, { pid: 222, isAlive: () => true })).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(111);
    expect(acquireLock(file, { pid: 333, isAlive: (p) => p !== 111 })).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(333);
  });
  it('isLockHeld reflects pid liveness; releaseLock only removes own lock', () => {
    const file = path.join(dir, 'ingest.lock');
    acquireLock(file, { pid: 111, isAlive: () => true });
    expect(isLockHeld(file, () => true)).toBe(true);
    expect(isLockHeld(file, () => false)).toBe(false);
    releaseLock(file, 999);
    expect(existsSync(file)).toBe(true);
    releaseLock(file, 111);
    expect(existsSync(file)).toBe(false);
  });
});

function harness(over: Partial<Parameters<typeof runDriver>[0]> = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const ac = new AbortController();
  const ensured: string[] = [];
  const statePath = path.join(dir, 'state.json');
  const growthPath = path.join(dir, 'growth.jsonl');
  const lockPath = path.join(dir, 'ingest.lock');
  const deps: Parameters<typeof runDriver>[0] = {
    ingestor: {
      async ensureNeighborsFor(a, ti) {
        ensured.push(`${a}|${ti}`);
        // like the real ingestor: a finished job marks the key searched
        const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { searched: {}, backoff: {} };
        st.searched[trackKeyOf(a, ti)] = t;
        writeFileSync(statePath, JSON.stringify(st));
        return { digging: true };
      },
      whenIdle: async () => {},
    },
    store: { trackSummaries: () => [], stats: async () => ({ tracklistCount: 4, trackCount: 50, pairCount: 70 }) },
    statePath,
    growthPath,
    lockPath,
    seeds: [{ artist: 'A', title: 'One' }, { artist: 'B', title: 'Two' }],
    counters: { softBlocks: 1, hardBlocks: 2 },
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
      if (sleeps.length >= 6) ac.abort();
    },
    log: () => {},
    signal: ac.signal,
    pid: process.pid,
    isAlive: () => true,
    ...over,
  };
  return { deps, sleeps, ensured, ac, growthPath, lockPath, statePath, now: () => t };
}

describe('runDriver', () => {
  it('runs one job at a time with a 20s gap and writes a growth line after each job', async () => {
    const h = harness();
    const code = await runDriver(h.deps);
    expect(code).toBe(0);
    expect(h.ensured.slice(0, 2)).toEqual(['A|One', 'B|Two']);
    const lines = readFileSync(h.growthPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ tracklists: 4, tracks: 50, pairs: 70, jobs: 1, softBlocks: 1, hardBlocks: 2 });
    expect(typeof lines[0].ts).toBe('number');
    expect(lines[1].jobs).toBe(2);
    expect(h.sleeps[0]).toBe(20_000);
  });

  it('sleeps until pausedUntil instead of fetching', async () => {
    const h = harness();
    writeFileSync(h.statePath, JSON.stringify({ searched: {}, backoff: {}, pausedUntil: h.now() + 3_600_000 }));
    await runDriver(h.deps);
    expect(h.sleeps[0]).toBe(3_600_000);
    expect(h.ensured[0]).toBe('A|One');
    expect(h.sleeps.length).toBeGreaterThan(1);
  });

  it('sleeps 30 min and recomputes when the frontier is empty', async () => {
    const h = harness({ seeds: [] });
    await runDriver(h.deps);
    expect(h.ensured).toEqual([]);
    expect(h.sleeps[0]).toBe(30 * 60_000);
  });

  it('exits 1 without touching a lock held by a live pid', async () => {
    const h = harness();
    writeFileSync(h.lockPath, JSON.stringify({ pid: 424242, startedAt: 1 }));
    expect(await runDriver(h.deps)).toBe(1);
    expect(h.ensured).toEqual([]);
    expect(JSON.parse(readFileSync(h.lockPath, 'utf8')).pid).toBe(424242);
  });

  it('takes over a stale lock and releases it on abort (SIGTERM path)', async () => {
    const h = harness({ isAlive: (p) => p !== 424242 });
    writeFileSync(h.lockPath, JSON.stringify({ pid: 424242, startedAt: 1 }));
    expect(await runDriver(h.deps)).toBe(0);
    expect(existsSync(h.lockPath)).toBe(false);
  });
});
