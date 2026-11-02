// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, mockFetch } from '../sources/helpers';

const analysePreview = vi.fn();
vi.mock('@/lib/analysis/previewAnalysis', () => ({ analysePreview: (...a: unknown[]) => analysePreview(...a), ANALYSIS_TIMEOUT_MS: 5000 }));

import { DANCEABILITY_PRIOR_SOURCE, danceabilityPrior, isComplete } from '@/lib/completeness';
import { getEntry, putManual, putManualMany, putResolved, setRetry } from '@/lib/metadataCache';
import { resolveWithStatus } from '@/lib/resolver';
import { resetBreakers } from '@/lib/search/breaker';
import { clearSearchCache } from '@/lib/search/cache';
import { resetProviderBudgets } from '@/lib/search/merge';
import { configureMusicBrainzLimiter } from '@/lib/sources/musicbrainz';
import { trackKeyOf, type Track } from '@/types/track';

const KEY = trackKeyOf('A', 'T');

beforeEach(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-prior-'));
  clearSearchCache();
  resetProviderBudgets();
  resetBreakers();
  configureMusicBrainzLimiter(0);
  analysePreview.mockReset();
  for (const k of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'GETSONGBPM_API_KEY', 'SOUNDSTAT_API_KEY', 'YOUTUBE_API_KEY', 'LASTFM_API_KEY'])
    vi.stubEnv(k, '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('danceabilityPrior', () => {
  it('is clamp(0.45 + 0.05 × energy, 0, 1) rounded to 2 dp', () => {
    expect(DANCEABILITY_PRIOR_SOURCE).toBe('estimate-prior');
    expect(danceabilityPrior(0)).toBe(0.45);
    expect(danceabilityPrior(5)).toBe(0.7);
    expect(danceabilityPrior(7.4)).toBe(0.82);
    expect(danceabilityPrior(10)).toBe(0.95);
    expect(danceabilityPrior(12)).toBe(1);
    expect(danceabilityPrior(-20)).toBe(0);
  });
});

describe('metadata cache: manual/MIK rows', () => {
  it('a manual bpm/key/energy row becomes complete with the prior, labelled estimate-prior', () => {
    const e = putManual(KEY, { bpm: 126, camelot: '8A', energy: 6 });
    expect(e.fields.danceability).toBe(0.75);
    expect(e.sources.danceability).toBe('estimate-prior');
    expect(e.reason).toBeUndefined();
    expect(putManualMany([{ key: 'x|y', fields: { bpm: 120, camelot: '1A', energy: 4 } }])[0].fields.danceability).toBe(0.65);
  });
  it('never overrides a real or manual danceability', () => {
    putResolved(KEY, { id: KEY, artist: 'A', title: 'T', danceability: 0.31, sources: { danceability: 'reccobeats' } });
    expect(putManual(KEY, { bpm: 126, camelot: '8A', energy: 6 }).fields.danceability).toBe(0.31);
    putManual('m|n', { danceability: 0.2 });
    const e = putManual('m|n', { bpm: 126, camelot: '8A', energy: 9 });
    expect(e.fields.danceability).toBe(0.2);
    expect(e.sources.danceability).toBe('manual');
  });
  it('a later real value replaces the prior', () => {
    putManual(KEY, { bpm: 126, camelot: '8A', energy: 6 });
    const e = putResolved(KEY, { id: KEY, artist: 'A', title: 'T', danceability: 0.4, sources: { danceability: 'preview-analysis' } });
    expect(e.fields.danceability).toBe(0.4);
    expect(e.sources.danceability).toBe('preview-analysis');
  });
});

describe('resolveWithStatus fills the prior once resolution is done', () => {
  const routes = (): Array<[string, () => Response]> => [
    ['api.deezer.com', () => json({ data: [{ id: 1, title: 'T', rank: 5, artist: { name: 'A' }, preview: 'dz' }] })],
    ['itunes.apple.com', () => json({ results: [] })],
    ['musicbrainz.org', () => json({ recordings: [] })],
  ];
  it('analysis gave bpm/key/energy but no danceability -> complete with the prior, persisted', async () => {
    mockFetch(routes());
    analysePreview.mockResolvedValue({ bpm: 128, camelot: '8A', energy: 8 });
    const t = await resolveWithStatus('A', 'T');
    expect(isComplete(t)).toBe(true);
    expect(t.unresolved).toBeUndefined();
    expect(t.danceability).toBe(0.85);
    expect(t.sources.danceability).toBe('estimate-prior');
    expect(getEntry(KEY)?.fields.danceability).toBe(0.85);
    expect(getEntry(KEY)?.reason).toBeUndefined();
  });
  it('a negatively cached entry with energy (e.g. a promo with MIK-less provider data) is completed from cache, no adapter call', async () => {
    putResolved(KEY, { id: KEY, artist: 'A', title: 'T', bpm: 124, camelot: '8A', energy: 6, sources: {}, unresolved: { reason: 'no-preview', missing: ['danceability'] } });
    const fetchFn = mockFetch([
      ['api.deezer.com', () => json({ data: [] })],
      ['itunes.apple.com', () => json({ results: [] })],
    ]);
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved).toBeUndefined();
    expect(t.danceability).toBe(0.75);
    expect(t.sources.danceability).toBe('estimate-prior');
    expect(getEntry(KEY)?.sources.danceability).toBe('estimate-prior');
    const hosts = new Set(fetchFn.mock.calls.map((c) => new URL(String(c[0])).hostname));
    expect([...hosts].every((h) => h === 'api.deezer.com' || h === 'itunes.apple.com')).toBe(true); // preview refresh only
  });
  it('a retryable entry still waiting for its retry is NOT filled (resolution is not done yet)', async () => {
    putResolved(KEY, { id: KEY, artist: 'A', title: 'T', bpm: 124, camelot: '8A', energy: 6, sources: {}, unresolved: { reason: 'timeout', missing: ['danceability'] } });
    setRetry(KEY, Date.now() + 60_000);
    mockFetch([]);
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved?.reason).toBe('timeout');
    expect(t.danceability).toBeUndefined();
  });
  it('no energy -> no prior', async () => {
    mockFetch(routes());
    analysePreview.mockResolvedValue({ bpm: 128, camelot: '8A' });
    const t = await resolveWithStatus('A', 'T');
    expect(t.unresolved?.missing).toEqual(['energy', 'danceability']);
  });
});

export type { Track };
