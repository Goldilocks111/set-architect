import { hann, magnitudeFrame } from './fft';

const FRAME = 2048;
const HOP = 512;

export interface LoudnessFeatures {
  rmsDb: number; // dBFS of the whole clip
  onsetRate: number; // spectral-flux onsets per second
  centroidHz: number; // mean spectral centroid of non-silent frames
  pulseClarity: number; // 0..1 strength of the best periodicity of the onset envelope in 60-200 BPM
  highRatio: number; // 0..1 share of spectral power above HIGH_HZ (hats, cymbals, noise: brightness)
}

const HIGH_HZ = 5000;
const HIGH_RATIO_CAP = 0.15;

// Least-squares fits against ReccoBeats energy (1-10) / danceability on the U2 bench (n=48 club tracks, 2026-11-02;
// bench/data/tune/fit.ts). MAE with the feature set chosen inside each leave-one-out fold: energy 1.02 (about the old
// placeholder; the 1.0 target is not demonstrated), danceability 0.083. The reference danceability barely varies across
// club tracks (0.5-1.0) and pulse clarity hardly predicts it, so the fit sits close to its mean: treat it as a weak signal.
export const ENERGY_COEFFS = { intercept: 8.69, rmsDb: 0.1178, highRatio: 26.16 };
export const DANCE_COEFFS = { intercept: 0.6372, pulseClarity: 0.05891, clubTempo: 0.04426 };

export function extractFeatures(pcm: Float32Array, sampleRate: number): LoudnessFeatures {
  let sq = 0;
  for (let i = 0; i < pcm.length; i++) sq += pcm[i] * pcm[i];
  const rms = Math.sqrt(sq / Math.max(1, pcm.length));
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -120;

  const window = hann(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const flux: number[] = [];
  let prev: Float64Array | undefined;
  let centroidSum = 0;
  let centroidFrames = 0;
  let highPower = 0;
  let totalPower = 0;
  const binHz = sampleRate / FRAME;
  for (let start = 0; start + FRAME <= pcm.length; start += HOP) {
    const mag = magnitudeFrame(pcm, start, window, re, im);
    let f = 0;
    let wsum = 0;
    let total = 0;
    for (let k = 0; k < mag.length; k++) {
      if (k > 0) {
        const p = mag[k] * mag[k];
        totalPower += p;
        if (k * binHz > HIGH_HZ) highPower += p;
      }
      const m = Math.log1p(mag[k] * 10);
      if (prev) f += Math.max(0, m - prev[k]);
      mag[k] = m;
      wsum += m * k * binHz;
      total += m;
    }
    if (prev) flux.push(f);
    if (total > 1e-6) {
      centroidSum += wsum / total;
      centroidFrames++;
    }
    prev = mag;
  }

  const envRate = sampleRate / HOP;
  const seconds = pcm.length / sampleRate;
  return {
    rmsDb,
    onsetRate: seconds > 0 ? countOnsets(flux) / seconds : 0,
    centroidHz: centroidFrames ? centroidSum / centroidFrames : 0,
    pulseClarity: pulseClarity(flux, envRate),
    highRatio: totalPower > 0 ? highPower / totalPower : 0,
  };
}

/** Local maxima of the flux above mean + 1 standard deviation (global, not local), at least 3 hops (~70 ms at 22.05 kHz) apart. */
function countOnsets(flux: number[]): number {
  if (flux.length < 3) return 0;
  const mean = flux.reduce((a, b) => a + b, 0) / flux.length;
  const sd = Math.sqrt(flux.reduce((a, b) => a + (b - mean) ** 2, 0) / flux.length);
  if (sd < 1e-6) return 0;
  const thr = mean + 1.0 * sd;
  let count = 0;
  let last = -Infinity;
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] > thr && flux[i] >= flux[i - 1] && flux[i] > flux[i + 1] && i - last >= 3) {
      count++;
      last = i;
    }
  }
  return count;
}

function pulseClarity(flux: number[], envRate: number): number {
  const n = flux.length;
  if (n < envRate * 4) return 0;
  const mean = flux.reduce((a, b) => a + b, 0) / n;
  const x = flux.map((v) => v - mean);
  let r0 = 0;
  for (const v of x) r0 += v * v;
  if (r0 < 1e-9) return 0;
  const minLag = Math.floor((envRate * 60) / 200);
  const maxLag = Math.min(Math.ceil((envRate * 60) / 60), n >> 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let r = 0;
    for (let i = 0; i + lag < n; i++) r += x[i] * x[i + lag];
    best = Math.max(best, (r / (n - lag)) / (r0 / n));
  }
  return Math.min(1, Math.max(0, best));
}

export function energyFrom(f: LoudnessFeatures): number {
  const c = ENERGY_COEFFS;
  // highRatio is capped at the top of the fitted range (max 0.12 on real tracks): pure noise reaches ~0.5
  const raw = c.intercept + c.rmsDb * f.rmsDb + c.highRatio * Math.min(f.highRatio, HIGH_RATIO_CAP);
  return Math.min(10, Math.max(1, Math.round(raw)));
}

/** 0..1, 2 decimals. A tempo inside the club range (95-150 BPM) adds a small bonus. */
export function danceabilityFrom(f: LoudnessFeatures, bpm?: number): number {
  const c = DANCE_COEFFS;
  const club = bpm !== undefined && bpm >= 95 && bpm <= 150 ? 1 : 0;
  const raw = c.intercept + c.pulseClarity * f.pulseClarity + c.clubTempo * club;
  return Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100;
}
