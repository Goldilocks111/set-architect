import { describe, expect, it } from 'vitest';
import { isCompliant } from '@/engine/compliance';
import type { Track } from '@/types/track';

const t = (o: Partial<Track>): Track => ({ id: 'x', artist: 'A', title: 'T', sources: {}, danceability: 0.6, ...o });
const last = t({ bpm: 128, camelot: '8A', energy: 5 });

describe('isCompliant (criterion 3: key-compatible AND ±6% tempo AND energy toward the arc target)', () => {
  // [description, candidate, target, expected]
  const table: Array<[string, Partial<Track>, number, boolean]> = [
    // key
    ['same key', { bpm: 128, camelot: '8A', energy: 5 }, 5, true],
    ['+1 same letter', { bpm: 128, camelot: '9A', energy: 5 }, 5, true],
    ['-1 same letter', { bpm: 128, camelot: '7A', energy: 5 }, 5, true],
    ['+2 energy boost', { bpm: 128, camelot: '10A', energy: 5 }, 5, true],
    ['relative major/minor', { bpm: 128, camelot: '8B', energy: 5 }, 5, true],
    ['-2 same letter is not compatible', { bpm: 128, camelot: '6A', energy: 5 }, 5, false],
    ['risky diagonal (9B) is not compatible', { bpm: 128, camelot: '9B', energy: 5 }, 5, false],
    ['jaws (+7) is not compatible', { bpm: 128, camelot: '3A', energy: 5 }, 5, false],
    ['clash is not compatible', { bpm: 128, camelot: '2A', energy: 5 }, 5, false],
    // bpm (±6% inclusive, half/double-time equivalence)
    ['+6% exactly', { bpm: 135.68, camelot: '8A', energy: 5 }, 5, true],
    ['-6% exactly', { bpm: 120.32, camelot: '8A', energy: 5 }, 5, true],
    ['+7% out of range', { bpm: 137, camelot: '8A', energy: 5 }, 5, false],
    ['-7% out of range', { bpm: 119, camelot: '8A', energy: 5 }, 5, false],
    ['half-time (64)', { bpm: 64, camelot: '8A', energy: 5 }, 5, true],
    ['half-time within 6% (66)', { bpm: 66, camelot: '8A', energy: 5 }, 5, true],
    ['double-time (256)', { bpm: 256, camelot: '8A', energy: 5 }, 5, true],
    ['double-time out of range (275)', { bpm: 275, camelot: '8A', energy: 5 }, 5, false],
    // energy toward the arc target
    ['moves toward target', { bpm: 128, camelot: '8A', energy: 6 }, 8, true],
    ['holds when last is on target', { bpm: 128, camelot: '8A', energy: 5 }, 5, true],
    ['within 1 of target although moving away', { bpm: 128, camelot: '8A', energy: 6 }, 5, true],
    ['moves away beyond 1', { bpm: 128, camelot: '8A', energy: 4 }, 8, false],
    ['overshoots further than last', { bpm: 128, camelot: '8A', energy: 9 }, 6, false],
    // unknown candidate values can't be verified
    ['unknown candidate key', { bpm: 128, energy: 5 }, 5, false],
    ['unknown candidate bpm', { camelot: '8A', energy: 5 }, 5, false],
    ['unknown candidate energy', { bpm: 128, camelot: '8A' }, 5, false],
  ];
  it.each(table)('%s', (_name, cand, target, expected) => {
    expect(isCompliant(last, t(cand), target)).toBe(expected);
  });

  it('Camelot wraps 12 → 1 and 1 → 12', () => {
    expect(isCompliant(t({ bpm: 128, camelot: '12A', energy: 5 }), t({ bpm: 128, camelot: '1A', energy: 5 }), 5)).toBe(true);
    expect(isCompliant(t({ bpm: 128, camelot: '1B', energy: 5 }), t({ bpm: 128, camelot: '12B', energy: 5 }), 5)).toBe(true);
    expect(isCompliant(t({ bpm: 128, camelot: '11A', energy: 5 }), t({ bpm: 128, camelot: '1A', energy: 5 }), 5)).toBe(true); // +2 boost across the wrap
  });

  it('a last track lacking a value is not compliant (cannot verify)', () => {
    const cand = t({ bpm: 128, camelot: '8A', energy: 5 });
    expect(isCompliant(t({ camelot: '8A', energy: 5 }), cand, 5)).toBe(false);
    expect(isCompliant(t({ bpm: 128, energy: 5 }), cand, 5)).toBe(false);
    expect(isCompliant(t({ bpm: 128, camelot: '8A' }), cand, 5)).toBe(false);
    expect(isCompliant(t({ bpm: 128, camelot: 'junk', energy: 5 }), cand, 5)).toBe(false);
  });
});
