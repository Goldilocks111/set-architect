import { describe, expect, it } from 'vitest';
import { chromagram, estimateKey, pitchBinMap, whiten, CHROMA_MIN_HZ } from '@/lib/analysis/key';

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

  it('pitch bins average their FFT bins: a flat spectrum gives the same value in every pitch bin', () => {
    const { target, counts } = pitchBinMap(11025, 4096);
    const bins = new Float64Array(counts.length);
    for (let k = 0; k < target.length; k++) if (target[k] >= 0) bins[target[k]] += 1; // flat magnitude 1
    for (let s = 0; s < bins.length; s++) if (counts[s] > 0) expect(bins[s] / counts[s]).toBe(1);
    // more FFT bins land in a high pitch bin than in a low one (why summing over-weights the treble)
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[Math.floor(counts.length / 2)]);
  });

  it('whiten subtracts the local mean and clamps at zero', () => {
    expect([...whiten(new Float64Array(40).fill(3), 5)]).toEqual(new Array(40).fill(0));
    const row = new Float64Array(41).fill(1);
    row[20] = 12; // a peak on a flat floor: 11 neighbours mean = (10 + 12) / 11 = 2
    const w = whiten(row, 5);
    expect(w[20]).toBeCloseTo(10, 9);
    expect(w[0]).toBe(0);
  });

  it('a C-major triad over a loud treble-heavy noise floor -> 8B', () => {
    const notes = [0, 4, 7, 0, 4, 7, 12].map((n) => semis(C + n));
    const pcm = tones(notes);
    let seed = 5;
    let prev = 0;
    for (let i = 0; i < pcm.length; i++) {
      seed = (seed * 16807) % 2147483647;
      const w = (seed / 2147483647) * 2 - 1;
      pcm[i] += 0.6 * (w - prev); // first difference: noise rising with frequency, like hats/cymbals
      prev = w;
    }
    expect(keyOf(pcm)?.camelot).toBe('8B');
  });

  it('44.1 kHz C-major triad with a loud 55 Hz off-key sub-bass still -> 8B', () => {
    const sr = 44100;
    const pcm = new Float32Array(sr * 10);
    const notes = [0, 4, 7, 0, 4, 7, 12].map((n) => semis(C + n));
    for (const f of notes)
      for (let h = 1; h <= 3; h++)
        for (let i = 0; i < pcm.length; i++) pcm[i] += (0.5 / h / notes.length) * Math.sin((2 * Math.PI * f * h * i) / sr);
    // A1 = 55 Hz is outside C major's tonic triad; loud kick-like sub
    const sub = 55 * 1.0595; // A#1: non-key pitch class
    for (let i = 0; i < pcm.length; i++) pcm[i] += 0.8 * Math.sin((2 * Math.PI * sub * i) / sr);
    expect(CHROMA_MIN_HZ).toBeGreaterThanOrEqual(100);
    expect(estimateKey(chromagram(pcm, sr))?.camelot).toBe('8B');
  });
});
