import { describe, expect, it } from 'vitest';
import { keyAgreement, maeEnergy, yieldTable, type DataRow } from '../../bench/data/score';

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
