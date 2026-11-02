import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAY_FRACTION, durationOf, estimatedDurationMs, formatMinutes, lengthAgrees } from '@/lib/duration';
import type { Track } from '@/types/track';

const t = (over: Partial<Track> = {}): Track => ({ id: 'a|b', artist: 'A', title: 'B', sources: {}, ...over });
const min = (m: number, s = 0) => (m * 60 + s) * 1000;

describe('estimatedDurationMs', () => {
  it('defaults to 5:00', () => {
    expect(estimatedDurationMs({ title: 'Song' })).toBe(min(5));
    expect(estimatedDurationMs({ title: 'Song', version: 'Some Remix' })).toBe(min(5));
  });
  it.each(['Extended Mix', 'Club Mix', 'Original Mix', 'extended version'])('%s -> 6:30', (version) => {
    expect(estimatedDurationMs({ title: 'Song', version })).toBe(min(6, 30));
  });
  it.each(['Radio Edit', 'Edit', 'radio mix'])('%s -> 3:30', (version) => {
    expect(estimatedDurationMs({ title: 'Song', version })).toBe(min(3, 30));
  });
  it('reads the version out of the title when no version label is set', () => {
    expect(estimatedDurationMs({ title: 'Song (Extended Mix)' })).toBe(min(6, 30));
    expect(estimatedDurationMs({ title: 'Song - Radio Edit' })).toBe(min(3, 30));
  });
});

describe('durationOf', () => {
  it('uses the real duration', () => {
    expect(durationOf(t({ durationMs: 215000 }))).toEqual({ ms: 215000, estimated: false });
  });
  it.each([undefined, 0, -5, NaN, Infinity])('estimates when durationMs is %s (never NaN)', (d) => {
    const r = durationOf(t({ durationMs: d as number | undefined, version: 'Extended Mix' }));
    expect(r).toEqual({ ms: min(6, 30), estimated: true });
  });
});

describe('formatMinutes', () => {
  it.each([
    [0, '0:00'], [5000, '0:05'], [min(3, 30), '3:30'], [min(59, 59), '59:59'], [min(60), '1:00:00'], [min(125, 7), '2:05:07'],
  ])('%i -> %s', (ms, out) => expect(formatMinutes(ms)).toBe(out));
  it('rounds to whole seconds and tolerates bad input', () => {
    expect(formatMinutes(1499)).toBe('0:01');
    expect(formatMinutes(NaN)).toBe('0:00');
    expect(formatMinutes(-10)).toBe('0:00');
  });
});

describe('lengthAgrees', () => {
  it.each([
    ['Opus', 'Opus (Extended Mix)', true],
    ['Opus (Radio Edit)', 'Opus (Extended Mix)', false],
    ['Opus (Radio Edit)', 'Opus - Radio Edit', true],
    ['Opus (Extended Mix)', 'Opus', false],
    ['Opus (Club Mix)', 'Opus (Extended Mix)', true],
    ['Opus (Radio Edit)', undefined, true],
    ['Opus (Extended Mix)', undefined, true],
  ])('requested %s vs hit %s -> %s', (want, got, ok) => expect(lengthAgrees(want, got)).toBe(ok));
});

it('DEFAULT_PLAY_FRACTION is 0.75', () => expect(DEFAULT_PLAY_FRACTION).toBe(0.75));
