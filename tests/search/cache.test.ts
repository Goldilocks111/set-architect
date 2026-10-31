import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergedHit, MergedSearchResponse } from '@/lib/search/types';

const hit = (key: string): MergedHit => ({
  key,
  artist: 'CamelPhat',
  baseTitle: 'Cola',
  version: { baseTitle: 'Cola', kind: 'original', featuring: [] },
  providers: ['deezer'],
  previewUrl: 'https://cdns-preview.dzcdn.net/x.mp3',
  score: 1,
});
const ok = (key = 'k'): MergedSearchResponse => ({ hits: [hit(key)], degraded: [] });

let cache: typeof import('@/lib/search/cache');
beforeEach(async () => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
  vi.resetModules();
  cache = await import('@/lib/search/cache');
});

describe('cachedMergedSearch', () => {
  it('answers a repeated normalized query from cache for 24h', async () => {
    const search = vi.fn(async () => ok());
    await cache.cachedMergedSearch('CamelPhat  Cola', search, 0);
    await cache.cachedMergedSearch('camelphat cola', search, 1000);
    await cache.cachedMergedSearch('Camelphát cola!', search, cache.CACHE_TTL_MS - 1);
    expect(search).toHaveBeenCalledTimes(1);
    await cache.cachedMergedSearch('camelphat cola', search, cache.CACHE_TTL_MS + 1);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('keeps a degraded response only briefly and never caches a total failure', async () => {
    const degraded = vi.fn(async (): Promise<MergedSearchResponse> => ({ hits: [hit('k')], degraded: ['spotify'] }));
    await cache.cachedMergedSearch('q', degraded, 0);
    await cache.cachedMergedSearch('q', degraded, cache.DEGRADED_TTL_MS - 1);
    expect(degraded).toHaveBeenCalledTimes(1);
    await cache.cachedMergedSearch('q', degraded, cache.DEGRADED_TTL_MS + 1);
    expect(degraded).toHaveBeenCalledTimes(2);

    const dead = vi.fn(async (): Promise<MergedSearchResponse> => ({ hits: [], degraded: ['spotify', 'deezer'] }));
    await cache.cachedMergedSearch('z', dead, 0);
    await cache.cachedMergedSearch('z', dead, 1);
    expect(dead).toHaveBeenCalledTimes(2);
  });

  it('returns previews fresh but never stores them', async () => {
    const fresh = await cache.cachedMergedSearch('q', async () => ok(), 0);
    expect(fresh.hits[0].previewUrl).toBeDefined();
    const cached = await cache.cachedMergedSearch('q', async () => ok('other'), 1);
    expect(cached.hits[0].previewUrl).toBeUndefined();
    cache.flushSearchCache();
    expect(fs.readFileSync(path.join(process.env.SETARCHITECT_DATA_DIR!, 'search', 'query-cache.json'), 'utf8')).not.toContain('dzcdn');
  });

  it('survives a restart through the data dir', async () => {
    await cache.cachedMergedSearch('q', async () => ok('persisted'), 0);
    cache.flushSearchCache();
    vi.resetModules();
    const fresh = await import('@/lib/search/cache');
    const search = vi.fn(async () => ok('new'));
    expect((await fresh.cachedMergedSearch('q', search, 10)).hits[0].key).toBe('persisted');
    expect(search).not.toHaveBeenCalled();
  });

  it('evicts the oldest entries beyond the size cap', async () => {
    for (let i = 0; i <= cache.CACHE_MAX_ENTRIES; i++) await cache.cachedMergedSearch(`q${i}`, async () => ok(), i);
    const search = vi.fn(async () => ok());
    await cache.cachedMergedSearch('q0', search, 1000);
    await cache.cachedMergedSearch(`q${cache.CACHE_MAX_ENTRIES}`, search, 1000);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
