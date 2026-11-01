import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '@/lib/dataDir';
import { getEntry, putManual, putResolved } from '@/lib/metadataCache';
import type { Track } from '@/types/track';

const t = (over: Partial<Track> = {}): Track => ({
  id: 'a|b', artist: 'A', title: 'B', bpm: 124, camelot: '8A', energy: 7, danceability: 0.6,
  previewUrl: 'https://x/p.mp3', sources: { bpm: 'deezer', camelot: 'getsongbpm', energy: 'reccobeats', danceability: 'reccobeats' }, ...over,
});

beforeEach(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-cache-'));
});

describe('metadataCache', () => {
  it('round-trips a resolved track, counts attempts, and does not persist the expiring previewUrl', () => {
    putResolved('a|b', t(), 1000);
    const e = putResolved('a|b', t(), 2000);
    expect(e.attempts).toBe(2);
    expect(e.resolvedAt).toBe(2000);
    expect(getEntry('a|b')?.fields.bpm).toBe(124);
    expect(getEntry('a|b')?.fields.previewUrl).toBeUndefined();
    expect(getEntry('a|b')?.sources.bpm).toBe('deezer');
  });
  it('manual fields survive putResolved', () => {
    putManual('a|b', { bpm: 130, camelot: '1B' });
    const e = putResolved('a|b', t());
    expect(e.fields.bpm).toBe(130);
    expect(e.fields.camelot).toBe('1B');
    expect(e.sources.bpm).toBe('manual');
    expect(e.fields.energy).toBe(7);
  });
  it('keeps earlier fields when a later resolve lacks them, and records the incomplete reason', () => {
    putResolved('a|b', t());
    const { energy: _e, ...rest } = t();
    const e = putResolved('a|b', { ...rest, unresolved: { reason: 'timeout', missing: ['energy'] } } as Track);
    expect(e.fields.energy).toBe(7);
    expect(e.reason).toBeUndefined(); // merged entry is complete
  });
  it('stores reason for an incomplete entry', () => {
    const e = putResolved('x|y', { id: 'x|y', artist: 'x', title: 'y', sources: {}, unresolved: { reason: 'no-preview', missing: ['bpm'] } });
    expect(e.reason).toBe('no-preview');
  });
  it('a corrupt cache file reads as empty without throwing', () => {
    fs.writeFileSync(dataDir('index', 'metadata.json'), '{not json');
    expect(getEntry('a|b')).toBeUndefined();
    expect(putResolved('a|b', t()).attempts).toBe(1);
  });
});
