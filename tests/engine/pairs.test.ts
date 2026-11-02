import { describe, expect, it } from 'vitest';
import { pairViolations } from '@/engine';
import { pairCheck } from '@/engine/pairs';
import type { Track } from '@/types/track';

const arc = { minutes: 60, shape: 'build' } as const;
const t = (o: Partial<Track>): Track => ({ id: 'x', artist: 'A', title: 'T', sources: {}, danceability: 0.6, ...o });
const base = t({ bpm: 128, camelot: '8A', energy: 5 });
const kinds = (c: Partial<Track>) => pairViolations([base, t(c)], arc)[0]?.issues.map((i) => i.kind) ?? [];

describe('pairViolations', () => {
  it('clean pair yields nothing', () => {
    expect(pairViolations([base, t({ bpm: 128, camelot: '9A', energy: 6 })], arc)).toEqual([]);
  });
  it('index is the incoming track and label names the clash', () => {
    const r = pairViolations([base, t({ bpm: 128, camelot: '3B', energy: 5 })], arc);
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(1);
    expect(r[0].issues[0]).toEqual({ kind: 'key', label: 'Key clash 8A→3B' });
  });
  it('key: boost/relative ok, -2, jaws, risky violate; wrap 12A→1A ok', () => {
    expect(kinds({ bpm: 128, camelot: '10A', energy: 5 })).toEqual([]);
    expect(kinds({ bpm: 128, camelot: '8B', energy: 5 })).toEqual([]);
    expect(kinds({ bpm: 128, camelot: '6A', energy: 5 })).toEqual(['key']);
    expect(kinds({ bpm: 128, camelot: '3A', energy: 5 })).toEqual(['key']);
    expect(kinds({ bpm: 128, camelot: '9B', energy: 5 })).toEqual(['key']);
    expect(pairViolations([t({ camelot: '12A' }), t({ camelot: '1A' })], arc)).toEqual([]);
    expect(pairViolations([t({ camelot: '1A' }), t({ camelot: '12A' })], arc)).toEqual([]);
  });
  it('tempo: ±6% ok, 7% bad, half/double ok', () => {
    expect(kinds({ bpm: 135.68, camelot: '8A', energy: 5 })).toEqual([]);
    expect(kinds({ bpm: 137, camelot: '8A', energy: 5 })).toEqual(['tempo']);
    expect(kinds({ bpm: 64, camelot: '8A', energy: 5 })).toEqual([]);
    expect(kinds({ bpm: 256, camelot: '8A', energy: 5 })).toEqual([]);
    expect(kinds({ bpm: 275, camelot: '8A', energy: 5 })).toEqual(['tempo']);
  });
  it('energy: +1 ok, +2 needs boost, +3 always bad, -3 ok, -4 crash', () => {
    expect(kinds({ bpm: 128, camelot: '8A', energy: 6 })).toEqual([]);
    expect(kinds({ bpm: 128, camelot: '8A', energy: 7 })).toEqual(['energy']);
    expect(kinds({ bpm: 128, camelot: '10A', energy: 7 })).toEqual([]);
    expect(kinds({ bpm: 128, camelot: '10A', energy: 8 })).toEqual(['energy']);
    expect(kinds({ bpm: 128, camelot: '8A', energy: 2 })).toEqual([]);
    const crash = pairViolations([base, t({ bpm: 128, camelot: '8A', energy: 1 })], arc);
    expect(crash[0].issues).toEqual([{ kind: 'energy', label: 'Energy crash 5→1' }]);
  });
  it('unknown values never violate; neighbours are literal', () => {
    expect(pairViolations([base, t({ bpm: 128, camelot: '8A' })], arc)).toEqual([]);
    expect(pairViolations([base, t({}), t({ bpm: 90, camelot: '3B', energy: 1 })], arc)).toEqual([]);
    expect(pairCheck(base, t({ bpm: 128 })).key).toBe('unknown');
  });
  it('multiple issues and indices', () => {
    const r = pairViolations([base, t({ bpm: 128, camelot: '8A', energy: 5 }), t({ bpm: 90, camelot: '3B', energy: 9 })], arc);
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(2);
    expect(r[0].issues.map((i) => i.kind)).toEqual(['key', 'tempo', 'energy']);
  });
});
