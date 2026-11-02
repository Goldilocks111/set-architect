import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '@/lib/dataDir';
import { getEntries, getEntry, putManual, putManualMany, putResolved } from '@/lib/metadataCache';
import type { Track } from '@/types/track';

const t = (over: Partial<Track> = {}): Track => ({
  id: 'a|b', artist: 'A', title: 'B', bpm: 124, camelot: '8A', energy: 7, danceability: 0.6,
  previewUrl: 'https://x/p.mp3', sources: { bpm: 'deezer', camelot: 'getsongbpm', energy: 'reccobeats', danceability: 'reccobeats' }, ...over,
});

beforeEach(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-cache-'));
});

describe('putManualMany', () => {
  it('writes the file once for the whole batch, marks fields manual, and last item wins', () => {
    const spy = vi.spyOn(fs, 'writeFileSync');
    const entries = putManualMany([
      { key: 'a|1', fields: { bpm: 120 } },
      { key: 'a|2', fields: { camelot: '8A', energy: 6 } },
      { key: 'a|1', fields: { bpm: 125 } },
    ]);
    expect(spy.mock.calls.filter(([f]) => String(f).includes('metadata.json'))).toHaveLength(1);
    spy.mockRestore();
    expect(entries).toHaveLength(3);
    expect(getEntry('a|1')?.fields.bpm).toBe(125);
    expect(getEntry('a|1')?.sources.bpm).toBe('manual');
    expect(getEntry('a|2')?.fields).toMatchObject({ camelot: '8A', energy: 6 });
  });
  it('does not touch the file for an empty batch', () => {
    const spy = vi.spyOn(fs, 'writeFileSync');
    expect(putManualMany([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
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

describe('snapshot lookups (getEntries)', () => {
  const seedFile = (n: number) => {
    const cache = Object.fromEntries(Array.from({ length: n }, (_, i) => [`a|${i}`, { fields: { bpm: 100 + i }, sources: {}, resolvedAt: 1, attempts: 1 }]));
    fs.writeFileSync(dataDir('index', 'metadata.json'), JSON.stringify(cache));
  };

  it('parses the cache file once for any number of lookups', () => {
    seedFile(50);
    const spy = vi.spyOn(fs, 'readFileSync');
    const keys = Array.from({ length: 50 }, (_, i) => `a|${i}`);
    const got = getEntries([...keys, 'nope|x']);
    for (const k of keys) getEntry(k);
    const reads = spy.mock.calls.filter(([f]) => String(f).includes('metadata.json')).length;
    spy.mockRestore();
    expect(got.size).toBe(50);
    expect(got.get('a|7')?.fields.bpm).toBe(107);
    expect(got.has('nope|x')).toBe(false);
    expect(reads).toBe(1);
  });

  it('sees a changed file (size/mtime) and its own writes', () => {
    seedFile(3);
    expect(getEntry('a|1')?.fields.bpm).toBe(101);
    seedFile(4);
    expect(getEntry('a|3')?.fields.bpm).toBe(103);
    putManual('a|1', { bpm: 150 });
    expect(getEntries(['a|1']).get('a|1')?.fields.bpm).toBe(150);
  });

  it('is empty for a missing file', () => {
    expect(getEntries(['a|1']).size).toBe(0);
  });

  it('does not read keys inherited from Object.prototype', () => {
    seedFile(1);
    expect(getEntries(['constructor', '__proto__']).size).toBe(0);
  });
});
