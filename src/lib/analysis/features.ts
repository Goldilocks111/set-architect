import { hann, magnitudeFrame } from './fft';

const FRAME = 2048;
const HOP = 512;

export interface LoudnessFeatures {
  rmsDb: number; // dBFS of the whole clip
  onsetRate: number; // spectral-flux onsets per second
  centroidHz: number; // mean spectral centroid of non-silent frames
  pulseClarity: number; // 0..1 strength of the best periodicity of the onset envelope in 60-200 BPM
}

// Placeholders: Task 3 fits these against labelled tracks.
export const ENERGY_COEFFS = { intercept: 5.5, rmsDb: 0.12, onsetRate: 0.3, centroidHz: 0.0005 };
export const DANCE_COEFFS = { intercept: 0.05, pulseClarity: 0.9, onsetRate: 0.01 };

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
  const binHz = sampleRate / FRAME;
  for (let start = 0; start + FRAME <= pcm.length; start += HOP) {
    const mag = magnitudeFrame(pcm, start, window, re, im);
    let f = 0;
    let wsum = 0;
    let total = 0;
    for (let k = 0; k < mag.length; k++) {
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
  };
}

/** Peaks above an adaptive threshold (local median + k * MAD-ish spread), at least ~60 ms apart. */
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
  const raw = c.intercept + c.rmsDb * f.rmsDb + c.onsetRate * f.onsetRate + c.centroidHz * f.centroidHz;
  return Math.min(10, Math.max(1, Math.round(raw)));
}

/** 0..1, 2 decimals. A tempo inside the club range (95-150 BPM) adds a small bonus. */
export function danceabilityFrom(f: LoudnessFeatures, bpm?: number): number {
  const c = DANCE_COEFFS;
  const tempoBonus = bpm !== undefined && bpm >= 95 && bpm <= 150 ? 0.05 : 0;
  const raw = c.intercept + c.pulseClarity * f.pulseClarity + c.onsetRate * Math.min(f.onsetRate, 8) + tempoBonus;
  return Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100;
}
