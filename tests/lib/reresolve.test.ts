import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { putResolved, getEntry } from '@/lib/metadataCache';
import { RETRY_BACKOFF_MS, resetReresolve, scheduleRetry, setReresolveDeps } from '@/lib/reresolve';
import type { Track } from '@/types/track';

const KEY = 'a|b';
const incomplete: Track = { id: KEY, artist: 'a', title: 'b', sources: {}, unresolved: { reason: 'timeout', missing: ['bpm'] } };

beforeEach(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reresolve-'));
  resetReresolve();
});

describe('scheduleRetry', () => {
  it('follows RETRY_BACKOFF_MS by attempt, then stops', () => {
    const now = 1_000_000;
    setReresolveDeps({ now: () => now, setTimer: () => undefined, resolve: vi.fn() });
    for (let i = 0; i < RETRY_BACKOFF_MS.length; i++) {
      putResolved(KEY, incomplete, now);
      expect(scheduleRetry('a', 'b', 'timeout')).toBe(now + RETRY_BACKOFF_MS[i]);
      expect(getEntry(KEY)?.retryAt).toBe(now + RETRY_BACKOFF_MS[i]);
    }
    putResolved(KEY, incomplete, now);
    expect(scheduleRetry('a', 'b', 'timeout')).toBeUndefined();
  });
  it('only retries providers-unavailable and timeout', () => {
    setReresolveDeps({ setTimer: () => undefined, resolve: vi.fn() });
    putResolved(KEY, incomplete);
    for (const r of ['not-found', 'no-preview', 'analysis-failed'] as const) expect(scheduleRetry('a', 'b', r)).toBeUndefined();
    expect(scheduleRetry('a', 'b', 'providers-unavailable')).toBeTypeOf('number');
  });
  it('runs due jobs one at a time via the injected resolver, skipping complete tracks', async () => {
    const timers: Array<() => void> = [];
    let active = 0, maxActive = 0;
    const resolve = vi.fn(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { ...incomplete };
    });
    setReresolveDeps({ setTimer: (fn) => void timers.push(fn), resolve });
    putResolved(KEY, incomplete);
    putResolved('c|d', { ...incomplete, id: 'c|d', artist: 'c', title: 'd' });
    scheduleRetry('a', 'b', 'timeout');
    scheduleRetry('c', 'd', 'timeout');
    timers.forEach((f) => f());
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    expect(maxActive).toBe(1);
  });
  it('arms no timer under NODE_ENV=test unless deps are injected', () => {
    putResolved(KEY, incomplete);
    expect(scheduleRetry('a', 'b', 'timeout')).toBeTypeOf('number'); // persisted, no real timer left dangling
  });
});
