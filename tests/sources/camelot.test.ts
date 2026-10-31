import { describe, expect, it } from 'vitest';
import { energyTo10, keyNameToCamelot, toCamelot } from '@/lib/sources/camelot';

describe('toCamelot', () => {
  it('maps all 24 key/mode pairs', () => {
    const majors = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
    const minors = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
    for (let k = 0; k < 12; k++) {
      expect(toCamelot(k, 1)).toBe(majors[k]);
      expect(toCamelot(k, 0)).toBe(minors[k]);
    }
  });
  it('known anchors: A minor = 8A, C major = 8B', () => {
    expect(toCamelot(9, 0)).toBe('8A');
    expect(toCamelot(0, 1)).toBe('8B');
  });
  it('rejects invalid input', () => {
    expect(toCamelot(12, 1)).toBeUndefined();
    expect(toCamelot(-1, 0)).toBeUndefined();
    expect(toCamelot(3, 2)).toBeUndefined();
    expect(toCamelot(1.5, 1)).toBeUndefined();
  });
  it('parses key names', () => {
    expect(keyNameToCamelot('Am')).toBe('8A');
    expect(keyNameToCamelot('C♯m')).toBe('12A');
    expect(keyNameToCamelot('Bb')).toBe('6B');
    expect(keyNameToCamelot('nonsense')).toBeUndefined();
  });
  it('scales energy to 1..10', () => {
    expect(energyTo10(0)).toBe(1);
    expect(energyTo10(1)).toBe(10);
    expect(energyTo10(NaN)).toBeUndefined();
  });
});
