import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, mockFetch } from './helpers';

const analysePreview = vi.fn();
vi.mock('@/lib/analysis/previewAnalysis', () => ({ analysePreview: (...a: unknown[]) => analysePreview(...a), ANALYSIS_TIMEOUT_MS: 5000 }));

import { resolveTrack } from '@/lib/resolver';
import { clearSearchCache } from '@/lib/search/cache';
import { resetProviderBudgets } from '@/lib/search/merge';
import { configureMusicBrainzLimiter } from '@/lib/sources/musicbrainz';

beforeEach(() => {
  process.env.SETARCHITECT_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-prev-'));
  clearSearchCache();
  resetProviderBudgets();
  configureMusicBrainzLimiter(0);
  analysePreview.mockReset();
  for (const k of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'GETSONGBPM_API_KEY', 'SOUNDSTAT_API_KEY', 'YOUTUBE_API_KEY', 'LASTFM_API_KEY'])
    vi.stubEnv(k, '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('resolveTrack preview-analysis fallback', () => {
  it('fills key/energy/danceability (not only bpm) with preview-analysis provenance, never overwriting', async () => {
    mockFetch([
      ['api.deezer.com', () => json({ data: [{ id: 1, title: 'T', rank: 5, preview: 'dz-preview', bpm: 128, artist: { name: 'A' } }] })],
      ['itunes.apple.com', () => json({ results: [] })],
      ['musicbrainz.org', () => json({ recordings: [] })],
    ]);
    analysePreview.mockResolvedValue({ bpm: 99, camelot: '8A', energy: 7, danceability: 0.7 });
    const t = await resolveTrack('A', 'T');
    expect(analysePreview).toHaveBeenCalled();
    expect(t.camelot).toBe('8A');
    expect(t.energy).toBe(7);
    expect(t.danceability).toBe(0.7);
    expect(t.sources.camelot).toBe('preview-analysis');
    if (t.sources.bpm !== 'preview-analysis') expect(t.bpm).not.toBe(99);
  });
});
