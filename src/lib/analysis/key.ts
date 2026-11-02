import { hann, magnitudeFrame } from './fft';
import { toCamelot } from '../sources/camelot';

// Chroma is computed on audio decimated to ~CHROMA_RATE: with a 4096-point FFT that gives ~2.7 Hz bins, so a semitone
// (6.5 Hz at 110 Hz) spans more than one bin. Below CHROMA_MIN_HZ kick/sub-bass can't be resolved to a pitch class and
// only pollutes the chroma, so it is excluded.
export const CHROMA_FRAME = 4096;
export const CHROMA_HOP = 2048;
export const CHROMA_MIN_HZ = 110;
export const CHROMA_MAX_HZ = 4000;
export const CHROMA_RATE = 11025;

// FFT bins are first gathered into 1/PITCH_SUB-semitone pitch bins spanning MIDI PITCH_LO..PITCH_HI (55 Hz - ~4 kHz),
// each the MEAN of its FFT bins (summing over-weights the treble, where one semitone holds dozens of bins), then
// whitened against a +-WHITEN_SEMITONES moving average so broadband drums/noise drop out and only spectral peaks
// (notes) remain. Tuned on the U2 bench, 2026-11-02 (bench/data/tune/key.ts).
const PITCH_LO = 33;
const PITCH_HI = 107;
const PITCH_SUB = 5;
const PITCH_BINS = (PITCH_HI - PITCH_LO + 1) * PITCH_SUB;
const WHITEN_SEMITONES = 6;

/** Below this best-profile Pearson correlation the key is reported as unknown (85% yield on the U2 bench). */
export const KEY_MIN_CONFIDENCE = 0.5;

// Index 0 = tonic. Krumhansl & Kessler (1982) probe-tone ratings; Temperley (2005) profiles (the default: on the U2
// bench Krumhansl's strong dominant made it pick the neighbouring fifth far more often).
// The EDM-tuned profiles (Faraldo et al. 2016, 'edma') are not shipped: exact values could not be sourced with confidence.
const PROFILES = {
  krumhansl: {
    major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  },
  temperley: {
    major: [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
    minor: [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
  },
} as const;

export type KeyProfile = keyof typeof PROFILES;

/** Pitch bin of every FFT bin (-1 outside the range) and how many FFT bins each pitch bin gathers. */
export function pitchBinMap(sampleRate: number, frame: number): { target: Int16Array; counts: Float64Array } {
  const target = new Int16Array(frame / 2).fill(-1);
  const counts = new Float64Array(PITCH_BINS);
  const binHz = sampleRate / frame;
  for (let k = 1; k < frame / 2; k++) {
    const s = Math.round((12 * Math.log2((k * binHz) / 440) + 69 - PITCH_LO) * PITCH_SUB);
    if (s >= 0 && s < PITCH_BINS) {
      target[k] = s;
      counts[s]++;
    }
  }
  return { target, counts };
}

/** Each value minus the mean of the `half` values either side of it (window clipped at the ends), floored at 0. */
export function whiten(row: Float64Array, half: number): Float64Array {
  const n = row.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + row[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    out[i] = Math.max(0, row[i] - (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1));
  }
  return out;
}

/** 12-bin pitch-class energy (C..B) of the whitened pitch spectrum, summed over all frames, normalised to sum 1 (all zero for silence). */
export function chromagram(pcm: Float32Array, sampleRate: number): Float64Array {
  const chroma = new Float64Array(12);
  const factor = Math.max(1, Math.round(sampleRate / CHROMA_RATE));
  if (factor > 1) {
    // boxcar average = crude anti-alias low-pass; a proper FIR made no difference on the U2 bench
    const out = new Float32Array(Math.floor(pcm.length / factor));
    for (let i = 0; i < out.length; i++) {
      let acc = 0;
      for (let j = 0; j < factor; j++) acc += pcm[i * factor + j];
      out[i] = acc / factor;
    }
    pcm = out;
    sampleRate /= factor;
  }
  const FRAME = CHROMA_FRAME;
  const HOP = CHROMA_HOP;
  const window = hann(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const { target, counts } = pitchBinMap(sampleRate, FRAME);
  const pcOfPitch = new Int8Array(PITCH_BINS).fill(-1);
  for (let s = 0; s < PITCH_BINS; s++) {
    const hz = 440 * 2 ** ((PITCH_LO + s / PITCH_SUB - 69) / 12);
    if (hz >= CHROMA_MIN_HZ && hz <= CHROMA_MAX_HZ) pcOfPitch[s] = (PITCH_LO + Math.round(s / PITCH_SUB)) % 12;
  }
  const bins = new Float64Array(PITCH_BINS);
  for (let start = 0; start + FRAME <= pcm.length; start += HOP) {
    const mag = magnitudeFrame(pcm, start, window, re, im);
    bins.fill(0);
    for (let k = 1; k < target.length; k++) if (target[k] >= 0) bins[target[k]] += mag[k];
    for (let s = 0; s < PITCH_BINS; s++) if (counts[s] > 0) bins[s] /= counts[s];
    const white = whiten(bins, WHITEN_SEMITONES * PITCH_SUB);
    for (let s = 0; s < PITCH_BINS; s++) if (pcOfPitch[s] >= 0) chroma[pcOfPitch[s]] += white[s];
  }
  let sum = 0;
  for (const v of chroma) sum += v;
  if (sum > 0) for (let i = 0; i < 12; i++) chroma[i] /= sum;
  return chroma;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Best of 24 rotated key profiles by Pearson correlation; undefined when the best correlation is below KEY_MIN_CONFIDENCE. */
export function estimateKey(
  chroma: Float64Array,
  profile: KeyProfile = 'temperley'
): { camelot: string; confidence: number } | undefined {
  const p = PROFILES[profile];
  let best = { tonic: 0, mode: 1, r: -Infinity };
  for (const [mode, table] of [[1, p.major], [0, p.minor]] as const) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const rotated = table.map((_, i) => table[(i - tonic + 12) % 12]);
      const r = pearson(chroma, rotated);
      if (r > best.r) best = { tonic, mode, r };
    }
  }
  if (!(best.r >= KEY_MIN_CONFIDENCE)) return undefined;
  const camelot = toCamelot(best.tonic, best.mode);
  return camelot ? { camelot, confidence: best.r } : undefined;
}
