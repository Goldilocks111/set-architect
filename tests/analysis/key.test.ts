import { describe, expect, it } from 'vitest';
import { chromagram, estimateKey } from '@/lib/analysis/key';

const SR = 22050;
const semis = (n: number) => 440 * 2 ** (n / 12); // n semitones from A4

/** Sum of sine tones with 3 harmonics each, `seconds` long. */
function tones(freqs: number[], seconds = 10): Float32Array {
  const pcm = new Float32Array(SR * seconds);
  for (const f of freqs) {
    for (let h = 1; h <= 3; h++) {
      const amp = 1 / h / freqs.length;
      for (let i = 0; i < pcm.length; i++) pcm[i] += amp * Math.sin((2 * Math.PI * f * h * i) / SR) * 0.5;
    }
  }
  return pcm;
}

// semitones relative to A4 for notes in octave 4/3: C4 = -9
const C = -9;
const keyOf = (pcm: Float32Array) => estimateKey(chromagram(pcm, SR));

describe('key detection', () => {
  it('C-major triad + scale -> 8B', () => {
    const notes = [0, 2, 4, 5, 7, 9, 11, 0, 4, 7, 0, 4, 7].map((n) => semis(C + n));
    expect(keyOf(tones(notes))?.camelot).toBe('8B');
  });

  it('A-minor triad -> 8A', () => {
    expect(keyOf(tones([semis(0), semis(3), semis(7), semis(0), semis(-12)]))?.camelot).toBe('8A');
  });

  it('F#-minor triad -> 11A', () => {
    const f = -3; // F#4 relative to A4
    expect(keyOf(tones([semis(f), semis(f + 3), semis(f + 7), semis(f), semis(f - 12)]))?.camelot).toBe('11A');
  });

  it('white noise -> undefined (low confidence)', () => {
    const pcm = new Float32Array(SR * 10);
    let seed = 7;
    for (let i = 0; i < pcm.length; i++) {
      seed = (seed * 16807) % 2147483647;
      pcm[i] = (seed / 2147483647) * 2 - 1;
    }
    expect(keyOf(pcm)).toBeUndefined();
  });

  it('chromagram is sum-normalised with 12 bins', () => {
    const c = chromagram(tones([semis(0)], 3), SR);
    expect(c).toHaveLength(12);
    expect(c.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});
