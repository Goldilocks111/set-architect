import { describe, expect, it } from 'vitest';
import { isEnergyBoostKey, parseCamelot, scoreKeyTransition } from '@/engine/camelot';

describe('parseCamelot', () => {
  it('parses valid keys', () => {
    expect(parseCamelot('8A')).toEqual({ num: 8, letter: 'A' });
    expect(parseCamelot('12b')).toEqual({ num: 12, letter: 'B' });
  });
  it('rejects invalid keys', () => {
    for (const k of ['', '0A', '13A', '8C', 'A8', '8', 'foo']) expect(parseCamelot(k)).toBeNull();
  });
});

describe('scoreKeyTransition', () => {
  const s = (a: string, b: string) => scoreKeyTransition(a, b).score;
  it('same key = 1.0', () => expect(s('8A', '8A')).toBe(1));
  it('±1 same letter = 0.9 including wrap', () => {
    expect(s('8A', '9A')).toBe(0.9);
    expect(s('8A', '7A')).toBe(0.9);
    expect(s('12A', '1A')).toBe(0.9);
    expect(s('1B', '12B')).toBe(0.9);
  });
  it('ring switch = 0.85', () => {
    expect(s('8A', '8B')).toBe(0.85);
    expect(s('3B', '3A')).toBe(0.85);
  });
  it('+2 = 0.6 labelled Energy boost', () => {
    expect(scoreKeyTransition('8A', '10A')).toEqual({ score: 0.6, label: 'Energy boost' });
    expect(s('12B', '2B')).toBe(0.6);
  });
  it('diagonal = 0.3, -3 = 0.2, -5 = 0.15', () => {
    expect(s('8A', '9B')).toBe(0.3);
    expect(s('8A', '7B')).toBe(0.3);
    expect(s('8A', '5A')).toBe(0.2);
    expect(s('8A', '3A')).toBe(0.15);
  });
  it('incompatible = 0', () => {
    expect(scoreKeyTransition('8A', '2A')).toEqual({ score: 0, label: 'Clash' });
    expect(s('8A', '11B')).toBe(0);
  });
  it('invalid key → Key unknown', () => {
    expect(scoreKeyTransition('8A', 'zz')).toEqual({ score: 0, label: 'Key unknown' });
    expect(scoreKeyTransition('', '8A')).toEqual({ score: 0, label: 'Key unknown' });
  });
  it('isEnergyBoostKey only for +2 same letter', () => {
    expect(isEnergyBoostKey('8A', '10A')).toBe(true);
    expect(isEnergyBoostKey('8A', '10B')).toBe(false);
    expect(isEnergyBoostKey('8A', '6A')).toBe(false);
  });
});
