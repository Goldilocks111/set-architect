import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, mockFetch } from './helpers';
import { resolveWithStatus, settleStyles } from '@/lib/resolver';
import { getEntry, putResolved } from '@/lib/metadataCache';
import { displayFromKey } from '@/app/api/suggest/assemble';
import { buildRatingFile, displayResolver, type Scenario } from '../../bench/recs/score';
import { trackKeyOf, type Suggestion } from '@/types/track';

const deezer = (artist: string, title: string) => ['api.deezer.com', () => json({ data: [{ id: 1, title, rank: 5, preview: 'p', artist: { name: artist } }] })] as [string, () => Response];

beforeEach(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'display-'));
  for (const k of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'GETSONGBPM_API_KEY', 'SOUNDSTAT_API_KEY', 'YOUTUBE_API_KEY', 'LASTFM_API_KEY']) vi.stubEnv(k, '');
});
afterEach(async () => {
  await settleStyles();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const COMPLETE = { bpm: 124, camelot: '8A', energy: 7, danceability: 0.5 };

describe('provider display names persist in the metadata cache', () => {
  it('a fresh resolve stores the first provider match (Deezer) casing', async () => {
    mockFetch([deezer('REAL Artist', 'Real TITLE (Club Mix)'), ['itunes.apple.com', () => json({ results: [] })], ['musicbrainz.org', () => json({ recordings: [] })]]);
    await resolveWithStatus('Real Artist', 'Real Title (Club Mix)');
    expect(getEntry(trackKeyOf('Real Artist', 'Real Title (Club Mix)'))?.display).toEqual({ artist: 'REAL Artist', title: 'Real TITLE (Club Mix)' });
  });

  it('a cached complete entry without a display name gets one from the preview refresh', async () => {
    const key = trackKeyOf('Old Artist', 'Old Title');
    putResolved(key, { id: key, artist: 'Old Artist', title: 'Old Title', ...COMPLETE, sources: { bpm: 'x' } });
    expect(getEntry(key)?.display).toBeUndefined();
    mockFetch([deezer('OLD Artist', 'Old TITLE'), ['itunes.apple.com', () => json({ results: [] })]]);
    await resolveWithStatus('Old Artist', 'Old Title');
    expect(getEntry(key)?.display).toEqual({ artist: 'OLD Artist', title: 'Old TITLE' });
  });

  it('a display name survives later cache writes (resolve, manual)', async () => {
    const key = trackKeyOf('Old Artist', 'Old Title');
    putResolved(key, { id: key, artist: 'Old Artist', title: 'Old Title', ...COMPLETE, sources: {} }, Date.now(), { artist: 'OLD Artist', title: 'Old TITLE' });
    putResolved(key, { id: key, artist: 'Old Artist', title: 'Old Title', ...COMPLETE, sources: {} });
    expect(getEntry(key)?.display).toEqual({ artist: 'OLD Artist', title: 'Old TITLE' });
    const { putManual } = await import('@/lib/metadataCache');
    putManual(key, { bpm: 125 });
    expect(getEntry(key)?.display).toEqual({ artist: 'OLD Artist', title: 'Old TITLE' });
  });
});

describe('rating names come from provider display names, through the real cache', () => {
  it('an external named via displayFromKey and a pool track both render with provider casing', async () => {
    const ext = displayFromKey(trackKeyOf('real  artist', 'real title')); // title-cased tell
    const pool = { artist: 'pool artist ', title: 'pool  title' }; // hand-typed pool spelling
    for (const [r, a, t] of [[ext, 'REAL Artist', 'Real TITLE'], [pool, 'POOL Artist', 'Pool TITLE']] as const) {
      const k = trackKeyOf(r.artist, r.title);
      putResolved(k, { id: k, artist: r.artist, title: r.title, ...COMPLETE, sources: {} }, Date.now(), { artist: a, title: t });
    }
    const display = displayResolver((k) => getEntry(k)?.display, new Map([[trackKeyOf(pool.artist, pool.title), pool]]));
    const crate = Array.from({ length: 12 }, (_, i) => ({ artist: `Pool ${i}`, title: `T${i}`, bpm: 124 }));
    const sc: Scenario = { id: 's', name: 'S', lane: 'techno', template: '60min', plannedLength: 10, set: [pool], crate };
    const sug = (artist: string, title: string, i: number): Suggestion => ({ track: { id: `x${i}`, artist, title, sources: {} }, score: 1, reasons: [] });
    const suggestions = [sug(ext.artist, ext.title, 0), sug(pool.artist, pool.title, 1)];
    const { file } = buildRatingFile([{ scenario: sc, suggestions, crate: [...crate, { ...pool, bpm: 124 }], lastBpm: 124 }], {
      fileId: 'r', lanePool: () => new Set([...crate.map((c) => trackKeyOf(c.artist, c.title)), trackKeyOf(pool.artist, pool.title)]), display,
    });
    const names = file.scenarios[0].lists.flatMap((l) => l.tracks.map((t) => `${t.artist} | ${t.title}`));
    expect(names).toContain('REAL Artist | Real TITLE');
    expect(names).toContain('POOL Artist | Pool TITLE');
    expect(file.scenarios[0].set).toEqual([{ artist: 'POOL Artist', title: 'Pool TITLE' }]);
    expect(names.join('\n')).not.toContain('Real Artist'); // the displayFromKey spelling is gone
  });

  it('falls back to the pool entry, then to the normalized input', () => {
    const pool = new Map([[trackKeyOf('A', 'B'), { artist: 'Pool A', title: 'Pool B' }]]);
    const d = displayResolver(() => undefined, pool);
    expect(d({ artist: 'a', title: 'b' })).toEqual({ artist: 'Pool A', title: 'Pool B' });
    expect(d({ artist: ' x  y ', title: 'z' })).toBeUndefined();
  });
});
