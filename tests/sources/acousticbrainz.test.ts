import { afterEach, describe, expect, it, vi } from 'vitest';
import { acousticbrainzAdapter } from '@/lib/sources/acousticbrainz';
import { keyScaleToCamelot } from '@/lib/sources/camelot';
import { base, json, mockFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const low = (id: string) => ({
  [id]: { '0': { rhythm: { bpm: 124.275222778 }, tonal: { key_key: 'E', key_scale: 'major' }, lowlevel: { average_loudness: 0.9 } } },
  mbid_mapping: {},
});
const high = (id: string) => ({ [id]: { '0': { highlevel: { danceability: { all: { danceable: 0.968, not_danceable: 0.032 } } } } } });

describe('acousticbrainzAdapter', () => {
  it('maps bpm, Camelot key, danceability and an energy estimate', async () => {
    mockFetch([
      ['/low-level', () => json(low('m1'))],
      ['/high-level', () => json(high('m1'))],
    ]);
    const out = await acousticbrainzAdapter.enrich(base({ mbid: 'm1' }));
    expect(out).toEqual({ bpm: 124.3, camelot: '12B', danceability: 0.968, energy: 9 });
  });

  it('does not supply energy when it is already known', async () => {
    mockFetch([
      ['/low-level', () => json(low('m1'))],
      ['/high-level', () => json({})],
    ]);
    const out = await acousticbrainzAdapter.enrich(base({ mbid: 'm1', energy: 5 }));
    expect(out.energy).toBeUndefined();
    expect(out.bpm).toBe(124.3);
  });

  it('tolerates empty results, failures, and a missing mbid', async () => {
    mockFetch([
      ['/low-level', () => json({ mbid_mapping: {} })],
      ['/high-level', () => json({}, 500)],
    ]);
    expect(await acousticbrainzAdapter.enrich(base({ mbid: 'm1' }))).toEqual({});
    expect(await acousticbrainzAdapter.enrich(base())).toEqual({});
  });

  it('labels the energy provenance as an estimate', () => {
    expect(acousticbrainzAdapter.fieldLabels?.energy).toBe('acousticbrainz-estimate');
  });
});

describe('keyScaleToCamelot', () => {
  it('converts Essentia key names', () => {
    expect(keyScaleToCamelot('A', 'minor')).toBe('8A');
    expect(keyScaleToCamelot('Bb', 'major')).toBe('6B');
    expect(keyScaleToCamelot('H', 'major')).toBeUndefined();
  });
});
