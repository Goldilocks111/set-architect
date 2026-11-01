import { describe, expect, it } from 'vitest';
import { keyAgreement, maeEnergy, yieldTable, type DataRow, type Essential } from '../../bench/data/score';

const row = (id: string, bucket: DataRow['bucket'], fields: DataRow['fields']): DataRow => ({
  id,
  bucket,
  fields,
  sources: {},
  latencyMs: 100,
});

describe('yieldTable', () => {
  const rows: DataRow[] = [
    row('a', 'classic', { bpm: 124, camelot: '8A', energy: 7, danceability: 0.8 }),
    row('b', 'classic', { bpm: 128, camelot: '9A', energy: 6 }),
    row('c', 'recent', {}),
    row('d', 'recent', {}),
  ];
  const t = yieldTable(rows);

  it('computes fractions overall', () => {
    expect(t.all).toEqual({ bpm: 0.5, camelot: 0.5, energy: 0.5, danceability: 0.25, complete: 0.25 });
  });
  it('splits by bucket', () => {
    expect(t.classic).toEqual({ bpm: 1, camelot: 1, energy: 1, danceability: 0.5, complete: 0.5 });
    expect(t.recent).toEqual({ bpm: 0, camelot: 0, energy: 0, danceability: 0, complete: 0 });
  });
  it('returns zeros for no rows', () => {
    expect(yieldTable([]).all.complete).toBe(0);
  });
});

describe('keyAgreement', () => {
  it.each([
    ['8A', '8A', 'exact'],
    ['8A', '8B', 'relative'],
    ['8A', '9A', 'fifth'],
    ['12A', '1A', 'fifth'],
    ['1A', '12A', 'fifth'],
    ['8A', '3B', 'miss'],
    ['8A', '9B', 'miss'],
  ])('%s vs %s = %s', (a, b, want) => {
    expect(keyAgreement(a, b)).toBe(want);
  });
});

describe('maeEnergy', () => {
  it('averages absolute error', () => {
    expect(maeEnergy([[5, 7], [6, 6]])).toBe(1);
  });
  it('is 0 for no pairs', () => {
    expect(maeEnergy([])).toBe(0);
  });
});

import { bpmAgrees, providersOnly, referencePairs, sourceBreakdown, LOCAL_SOURCE } from '../../bench/data/score';

describe('providersOnly', () => {
  it('drops fields sourced from preview-analysis', () => {
    const r: DataRow = {
      ...row('a', 'recent', { bpm: 120, camelot: '8A', energy: 6 }),
      sources: { bpm: 'getsongbpm', camelot: LOCAL_SOURCE, energy: LOCAL_SOURCE },
    };
    const [p] = providersOnly([r]);
    expect(p.fields).toEqual({ bpm: 120 });
    expect(r.fields.camelot).toBe('8A'); // input not mutated
  });
});

describe('sourceBreakdown', () => {
  it('counts fields supplied per source', () => {
    const r: DataRow = {
      ...row('a', 'recent', { bpm: 120, camelot: '8A', energy: 6 }),
      sources: { bpm: 'getsongbpm', camelot: 'acousticbrainz', energy: 'reccobeats', previewUrl: 'deezer' },
    };
    const r2: DataRow = { ...row('b', 'recent', { bpm: 100 }), sources: { bpm: 'getsongbpm' } };
    expect(sourceBreakdown([r, r2])).toEqual({ getsongbpm: 2, acousticbrainz: 1, reccobeats: 1 });
  });
});

describe('bpmAgrees', () => {
  it.each([
    [124, 125, true],
    [124, 130, false],
    [64, 128, true],
    [256, 128, true],
    [124, 62.5, true],
    [0, 120, false],
  ])('%s vs %s = %s', (a, b, want) => {
    expect(bpmAgrees(a, b)).toBe(want);
  });
});

describe('referencePairs', () => {
  const mkRow = (id: string, field: Essential, ref: number | string, src: string, loc: number | string): DataRow => ({
    ...row(id, 'classic', { [field]: ref }),
    sources: { [field]: src },
    local: { [field]: loc, ms: 1 } as DataRow['local'] & object,
  });
  it('only uses non-local reference sources and reports their breakdown', () => {
    const rows = [
      mkRow('a', 'energy', 6, 'reccobeats', 7),
      mkRow('b', 'energy', 5, LOCAL_SOURCE, 5),
      mkRow('c', 'energy', 4, 'soundstat', 4),
    ];
    const ref = referencePairs(rows, 'energy');
    expect(ref.pairs).toEqual([[6, 7], [4, 4]]);
    expect(ref.bySource).toEqual({ reccobeats: 1, soundstat: 1 });
  });
  it('skips rows without a local value', () => {
    const r = { ...mkRow('a', 'energy', 6, 'reccobeats', 7), local: undefined };
    expect(referencePairs([r], 'energy').pairs).toEqual([]);
  });
});
