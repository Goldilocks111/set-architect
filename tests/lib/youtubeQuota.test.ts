// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BenchRefused, createFetchGuard, HOSTS } from '../../bench/data/guardFetch';
import { RequestGate } from '../../bench/search/guard';
import { BENCH_WITHOUT, RECS_BUDGET } from '../../bench/recs/score';

const mocks = vi.hoisted(() => ({ resolver: { resolveWithStatus: vi.fn(), getSimilarTracks: vi.fn(), queueStyles: vi.fn() } }));
vi.mock('@/lib/resolver', () => mocks.resolver);

beforeEach(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ytquota-'));
  vi.resetAllMocks();
  mocks.resolver.resolveWithStatus.mockResolvedValue({ id: 'x', artist: 'A', title: 'T', sources: {} });
});

describe('I2: YouTube search.list only on user-initiated resolves', () => {
  it('candidate resolves and the background crate fill leave YouTube out (crate fill also on its retries)', async () => {
    const { loadSuggestDeps } = await import('@/app/api/suggest/assemble');
    const deps = await loadSuggestDeps();
    await deps.resolveTrack!('A', 'T');
    expect(mocks.resolver.resolveWithStatus.mock.calls[0][2].without).toContain('youtube');
    await deps.backgroundResolve!('A', 'T');
    const opts = mocks.resolver.resolveWithStatus.mock.calls[1][2];
    expect(opts.without).toEqual(expect.arrayContaining(['itunes', 'youtube']));
    expect(opts.retryWithout).toEqual(expect.arrayContaining(['itunes', 'youtube']));
  });

  it('scheduled re-resolve retries never call YouTube, and keep an intentional exclusion', async () => {
    const { putResolved } = await import('@/lib/metadataCache');
    const { resetReresolve, scheduleRetry, setReresolveDeps } = await import('@/lib/reresolve');
    resetReresolve();
    const timers: Array<() => void> = [];
    setReresolveDeps({ setTimer: (fn) => void timers.push(fn) });
    for (const [title, without] of [['plain', undefined], ['crate', ['itunes']]] as const) {
      putResolved(`a|${title}`, { id: 'x', artist: 'a', title, sources: {}, unresolved: { reason: 'timeout', missing: ['bpm'] } });
      scheduleRetry('a', title, 'timeout', without ? [...without] : undefined);
    }
    timers.forEach((t) => t());
    await vi.waitFor(() => expect(mocks.resolver.resolveWithStatus).toHaveBeenCalledTimes(2));
    const [plain, crate] = mocks.resolver.resolveWithStatus.mock.calls.map((c) => c[2]);
    expect(plain).toMatchObject({ force: true, without: ['youtube'] });
    expect(plain.retryWithout ?? []).not.toContain('youtube'); // not an intentional exclusion: re-added on every hop anyway
    expect(crate).toMatchObject({ force: true, without: ['itunes', 'youtube'], retryWithout: ['itunes'] });
    resetReresolve();
  });

  it('the bench guard maps googleapis.com to youtube and refuses it at budget 0', async () => {
    expect(HOSTS.find(([re]) => re.test('www.googleapis.com'))?.[1]).toBe('youtube');
    expect(RECS_BUDGET.youtube).toBe(0);
    expect(BENCH_WITHOUT).toEqual(expect.arrayContaining(['itunes', 'youtube']));
    const real = vi.fn(async () => new Response('{}'));
    const g = createFetchGuard({ real: real as any, gates: new Map([['youtube', new RequestGate(RECS_BUDGET.youtube)]]), gapMs: {} });
    await expect(g.fetch('https://www.googleapis.com/youtube/v3/search?q=x')).rejects.toBeInstanceOf(BenchRefused);
    expect(real).not.toHaveBeenCalled();
    expect(g.refused.youtube).toBe(1);
  });
});
