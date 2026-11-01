import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POST } from '@/app/api/tracks/override/route';
import { validateOverride } from '@/lib/overrideValidation';
import { getEntry, putResolved } from '@/lib/metadataCache';
import { resolveWithStatus } from '@/lib/resolver';
import { trackKeyOf } from '@/types/track';

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/tracks/override', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
const ok = { bpm: 126, camelot: '8A', energy: 7, danceability: 0.8 };

beforeEach(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'override-'));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('validateOverride', () => {
  it.each([
    [{ bpm: 59 }], [{ bpm: 201 }], [{ bpm: '120' }], [{ camelot: '13A' }], [{ camelot: '0B' }], [{ camelot: '8C' }],
    [{ energy: 0 }], [{ energy: 11 }], [{ energy: 5.5 }], [{ danceability: -0.1 }], [{ danceability: 1.1 }], [{}], [null], ['x'],
  ])('rejects %j', (fields) => {
    expect(validateOverride(fields).ok).toBe(false);
  });
  it('accepts boundaries and normalises camelot case', () => {
    expect(validateOverride({ bpm: 60, camelot: '12b', energy: 1, danceability: 0 })).toEqual({
      ok: true,
      fields: { bpm: 60, camelot: '12B', energy: 1, danceability: 0 },
    });
    expect(validateOverride({ bpm: 200, energy: 10, danceability: 1 }).ok).toBe(true);
  });
});

describe('POST /api/tracks/override', () => {
  it('400s on bad input', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post({ title: 't', fields: ok })).status).toBe(400);
    expect((await post({ artist: 'a', title: 't', fields: { bpm: 500 } })).status).toBe(400);
    expect((await post({ artist: 'a', title: 't', fields: { camelot: '13A' } })).status).toBe(400);
    expect(getEntry(trackKeyOf('a', 't'))).toBeUndefined();
  });

  it('stores manual values and returns the merged track', async () => {
    const res = await post({ artist: 'Art', title: 'Tune', fields: ok });
    expect(res.status).toBe(200);
    const { track } = await res.json();
    expect(track).toMatchObject({ ...ok, artist: 'Art', title: 'Tune' });
    expect(track.sources.bpm).toBe('manual');
    expect(track.unresolved).toBeUndefined();
  });

  it('a completing override is served as complete at once, past the negative cache', async () => {
    const key = trackKeyOf('Art', 'Tune');
    putResolved(key, { id: key, artist: 'Art', title: 'Tune', sources: {}, unresolved: { reason: 'no-preview', missing: ['bpm', 'camelot', 'energy', 'danceability'] } });
    expect(getEntry(key)?.reason).toBe('no-preview');
    await post({ artist: 'Art', title: 'Tune', fields: ok });
    const served = await resolveWithStatus('Art', 'Tune');
    expect(served.unresolved).toBeUndefined();
    expect(served).toMatchObject(ok);
  });

  it('manual override wins over later resolve', async () => {
    await post({ artist: 'Art', title: 'Tune', fields: ok });
    const key = trackKeyOf('Art', 'Tune');
    putResolved(key, { id: key, artist: 'Art', title: 'Tune', bpm: 99, energy: 2, sources: { bpm: 'getsongbpm', energy: 'x' } });
    const forced = await resolveWithStatus('Art', 'Tune', { force: true });
    expect(forced).toMatchObject({ bpm: 126, energy: 7 });
    expect(getEntry(key)?.sources.bpm).toBe('manual');
  });
});
