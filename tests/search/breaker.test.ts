import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRetryAfter } from '@/lib/http';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-test-'));
  process.env.SETARCHITECT_DATA_DIR = dir;
  vi.resetModules();
});
afterEach(() => {
  delete process.env.SETARCHITECT_DATA_DIR;
});

const load = async () => ({ ...(await import('@/lib/search/breaker')), HttpError: (await import('@/lib/http')).HttpError });

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('49830')).toBe(49_830_000);
    expect(parseRetryAfter(new Date(10_000 + 60_000).toUTCString(), 10_000)).toBe(60_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
  it('fetchWithTimeout attaches Retry-After to the HttpError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } })));
    const { fetchJson } = await import('@/lib/http');
    await expect(fetchJson('https://x')).rejects.toMatchObject({ status: 429, retryAfterMs: 120_000 });
    vi.unstubAllGlobals();
  });
});

describe('provider breaker', () => {
  it('honours Retry-After on 429 and persists it across a restart', async () => {
    const b = await load();
    b.recordFailure('spotify', new b.HttpError(429, 'u', 3600_000), 1_000);
    expect(b.cooldownUntil('spotify', 2_000)).toBe(3_601_000);
    vi.resetModules();
    const fresh = await load();
    expect(fresh.cooldownUntil('spotify', 2_000)).toBe(3_601_000);
    expect(fresh.cooldownUntil('spotify', 3_601_001)).toBe(0);
  });

  it('uses the default throttle cooldown for a 429 without Retry-After and for an iTunes 403', async () => {
    const b = await load();
    b.recordFailure('spotify', new b.HttpError(429, 'u'), 0);
    b.recordFailure('itunes', new b.HttpError(403, 'u'), 0);
    expect(b.cooldownUntil('spotify', 1)).toBe(b.THROTTLE_COOLDOWN_MS);
    expect(b.cooldownUntil('itunes', 1)).toBe(b.THROTTLE_COOLDOWN_MS);
  });

  it('opens a short cooldown only after a streak of 403/5xx, and a success resets the streak', async () => {
    const b = await load();
    b.recordFailure('deezer', new b.HttpError(503, 'u'), 0);
    b.recordFailure('deezer', new b.HttpError(403, 'u'), 0);
    b.recordSuccess('deezer');
    b.recordFailure('deezer', new b.HttpError(500, 'u'), 0);
    b.recordFailure('deezer', new b.HttpError(500, 'u'), 0);
    expect(b.cooldownUntil('deezer', 1)).toBe(0);
    b.recordFailure('deezer', new b.HttpError(500, 'u'), 0);
    expect(b.cooldownUntil('deezer', 1)).toBe(b.STREAK_COOLDOWN_MS);
  });

  it('ignores network errors and timeouts', async () => {
    const b = await load();
    for (let i = 0; i < 5; i++) b.recordFailure('deezer', new Error('timed out'), 0);
    expect(b.cooldownUntil('deezer', 1)).toBe(0);
  });
});
