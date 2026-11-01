import { describe, expect, it } from 'vitest';
import { isComplete, missingEssentials } from '@/lib/completeness';
import type { Track } from '@/types/track';

const full: Track = { id: 'a|b', artist: 'a', title: 'b', bpm: 124, camelot: '8A', energy: 7, danceability: 0.6, sources: {} };

describe('completeness', () => {
  it('a track with all four essentials is complete', () => {
    expect(isComplete(full)).toBe(true);
    expect(missingEssentials(full)).toEqual([]);
  });
  it('missing danceability alone is incomplete', () => {
    const { danceability: _d, ...rest } = full;
    expect(isComplete(rest as Track)).toBe(false);
    expect(missingEssentials(rest as Track)).toEqual(['danceability']);
  });
  it('danceability 0 counts as present', () => {
    expect(isComplete({ ...full, danceability: 0 })).toBe(true);
  });
  it('lists every missing essential; NaN and empty camelot are missing', () => {
    expect(missingEssentials({ id: 'x', artist: 'x', title: 'x', bpm: NaN, camelot: '', sources: {} })).toEqual([
      'bpm', 'camelot', 'energy', 'danceability',
    ]);
  });
});
