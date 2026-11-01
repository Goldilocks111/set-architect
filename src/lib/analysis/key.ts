import { hann, magnitudeFrame } from './fft';
import { toCamelot } from '../sources/camelot';

const FRAME = 4096;
const HOP = 2048;
const MIN_HZ = 55;
const MAX_HZ = 5000;

/** Below this best-profile Pearson correlation the key is reported as unknown (Task 3 tunes). */
export const KEY_MIN_CONFIDENCE = 0.5;

// Index 0 = tonic. Krumhansl & Kessler (1982) probe-tone ratings; Temperley (2005) profiles.
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

/** 12-bin pitch-class energy (C..B), summed magnitude over all frames, normalised to sum 1 (all zero for silence). */
export function chromagram(pcm: Float32Array, sampleRate: number): Float64Array {
  const chroma = new Float64Array(12);
  const window = hann(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const binHz = sampleRate / FRAME;
  const lo = Math.max(1, Math.ceil(MIN_HZ / binHz));
  const hi = Math.min(FRAME / 2 - 1, Math.floor(MAX_HZ / binHz));
  const pcOfBin = new Int8Array(FRAME / 2);
  for (let k = lo; k <= hi; k++) {
    const semis = Math.round(12 * Math.log2((k * binHz) / 440)) + 9; // A4 = pitch class 9
    pcOfBin[k] = ((semis % 12) + 12) % 12;
  }
  for (let start = 0; start + FRAME <= pcm.length; start += HOP) {
    const mag = magnitudeFrame(pcm, start, window, re, im);
    for (let k = lo; k <= hi; k++) chroma[pcOfBin[k]] += mag[k];
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
  profile: KeyProfile = 'krumhansl'
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
