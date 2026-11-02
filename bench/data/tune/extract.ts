/**
 * U2 tuning, fetch pass: for every bench row that had a local analysis, re-find its Deezer preview, decode it in memory
 * and store DERIVED numbers only (pitch spectrograms, features) under ~/.setarchitect/bench/u2-features.json.
 * Audio is never written to disk. Resumable: ids already in the output file are skipped.
 *
 *   npx tsx bench/data/tune/extract.ts <bench-result.json> [--limit=N]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../../../src/lib/dataDir';
import { analysePcm } from '../../../src/lib/analysis/previewAnalysis';
import { hann, magnitudeFrame } from '../../../src/lib/analysis/fft';
import type { DataRow } from '../score';
import { MIDI_LO, SUB, NBINS, type FeatureFile, type TrackFeatures } from './common';
import { DEEZER_DAILY_CAP, previewSession } from './preview';

const RATE = 11025;

const argv = process.argv.slice(2);
const benchFile = argv.find((a) => !a.startsWith('--'));
const limitArg = argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
if (!benchFile) throw new Error('usage: extract.ts <bench-result.json>');

/** Boxcar average, exactly as key.ts does it today (baseline). */
function decimateBoxcar(pcm: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(Math.floor(pcm.length / factor));
  for (let i = 0; i < out.length; i++) {
    let acc = 0;
    for (let j = 0; j < factor; j++) acc += pcm[i * factor + j];
    out[i] = acc / factor;
  }
  return out;
}

/** Blackman-windowed sinc low-pass at 0.9 x the new Nyquist, evaluated at the kept samples only. */
function decimateFir(pcm: Float32Array, factor: number, taps = 32 * factor + 1): Float32Array {
  const fc = 0.45 / factor; // cycles per input sample
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const out = new Float32Array(Math.floor(pcm.length / factor));
  for (let n = 0; n < out.length; n++) {
    const c = n * factor;
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const j = c + i - mid;
      if (j >= 0 && j < pcm.length) acc += h[i] * pcm[j];
    }
    out[n] = acc;
  }
  return out;
}

/** Frames x NBINS magnitude summed into 1/SUB-semitone bins from MIDI_LO (A=440 grid). */
function pitchSpec(pcm: Float32Array, sr: number, frame: number, hop: number): { frames: number; data: Float32Array } {
  const window = hann(frame);
  const re = new Float64Array(frame);
  const im = new Float64Array(frame);
  const binHz = sr / frame;
  const target = new Int16Array(frame / 2).fill(-1);
  for (let k = 1; k < frame / 2; k++) {
    const s = Math.round((12 * Math.log2((k * binHz) / 440) + 69 - MIDI_LO) * SUB);
    if (s >= 0 && s < NBINS) target[k] = s;
  }
  const frames = Math.max(0, Math.floor((pcm.length - frame) / hop) + 1);
  const data = new Float32Array(frames * NBINS);
  for (let f = 0; f < frames; f++) {
    const mag = magnitudeFrame(pcm, f * hop, window, re, im);
    for (let k = 1; k < frame / 2; k++) if (target[k] >= 0) data[f * NBINS + target[k]] += mag[k];
  }
  return { frames, data };
}

/** Magnitude-weighted circular mean of spectral-peak deviation from the A=440 grid, in cents (-50..50). */
function tuningCents(pcm: Float32Array, sr: number, frame = 8192, hop = 4096): number {
  const window = hann(frame);
  const re = new Float64Array(frame);
  const im = new Float64Array(frame);
  const binHz = sr / frame;
  let cx = 0;
  let cy = 0;
  for (let start = 0; start + frame <= pcm.length; start += hop) {
    const mag = magnitudeFrame(pcm, start, window, re, im);
    const lo = Math.ceil(100 / binHz);
    const hi = Math.floor(2000 / binHz);
    let max = 0;
    for (let k = lo; k <= hi; k++) max = Math.max(max, mag[k]);
    for (let k = lo; k <= hi; k++) {
      if (mag[k] < 0.1 * max || mag[k] <= mag[k - 1] || mag[k] < mag[k + 1]) continue;
      const a = mag[k - 1];
      const b = mag[k];
      const c = mag[k + 1];
      const d = (0.5 * (a - c)) / (a - 2 * b + c || 1e-12);
      const m = 12 * Math.log2(((k + d) * binHz) / 440);
      const ang = 2 * Math.PI * (m - Math.round(m));
      cx += b * Math.cos(ang);
      cy += b * Math.sin(ang);
    }
  }
  return (Math.atan2(cy, cx) / (2 * Math.PI)) * 100;
}

/** Candidate extra energy features at the native rate (2048-pt frames, hop 1024). */
function extras(pcm: Float32Array, sr: number): TrackFeatures['extras'] {
  const FRAME = 2048;
  const HOP = 1024;
  const window = hann(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const binHz = sr / FRAME;
  let flatSum = 0;
  let flatN = 0;
  let low = 0;
  let high = 0;
  let total = 0;
  for (let start = 0; start + FRAME <= pcm.length; start += HOP) {
    const mag = magnitudeFrame(pcm, start, window, re, im);
    let logSum = 0;
    let pSum = 0;
    for (let k = 1; k < FRAME / 2; k++) {
      const p = mag[k] * mag[k];
      logSum += Math.log(p + 1e-12);
      pSum += p;
      if (k * binHz < 150) low += p;
      if (k * binHz > 5000) high += p;
    }
    total += pSum;
    if (pSum > 1e-6) {
      flatSum += Math.exp(logSum / (FRAME / 2 - 1)) / (pSum / (FRAME / 2 - 1));
      flatN++;
    }
  }
  // short-term loudness (400 ms) spread
  const win = Math.round(0.4 * sr);
  const st: number[] = [];
  for (let s = 0; s + win <= pcm.length; s += win) {
    let sq = 0;
    for (let i = s; i < s + win; i++) sq += pcm[i] * pcm[i];
    st.push(10 * Math.log10(sq / win + 1e-12));
  }
  st.sort((a, b) => a - b);
  const q = (p: number) => st[Math.min(st.length - 1, Math.floor(p * st.length))] ?? 0;
  return {
    flatness: flatN ? flatSum / flatN : 0,
    lowRatio: total ? low / total : 0,
    highRatio: total ? high / total : 0,
    loudnessRange: q(0.95) - q(0.1),
  };
}

const b64 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

async function main(): Promise<void> {
  const bench = JSON.parse(readFileSync(benchFile!, 'utf8')) as { rows: DataRow[] };
  const tracks: Array<{ id: string; artist: string; title: string }> = JSON.parse(
    readFileSync(join(__dirname, '../../search/tracks.json'), 'utf8'),
  );
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const outFile = dataDir('bench', 'u2-features.json');
  const out: FeatureFile = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : { tracks: {} };

  const session = previewSession();
  const { gate, guard } = session;
  const startCount = gate.count;

  const todo = bench.rows.filter((r) => r.local && !out.tracks[r.id]).slice(0, LIMIT);
  console.log(`${todo.length} rows to fetch; deezer count today ${startCount}/${DEEZER_DAILY_CAP}`);
  for (const [i, row] of todo.entries()) {
    const t = byId.get(row.id);
    if (!t) continue;
    try {
      const got = await session.fetchPcm(t.artist, t.title);
      if (typeof got === 'string') {
        console.log(`[${i + 1}] ${row.id}: ${got}`);
        continue;
      }
      const { pcm, sampleRate: sr } = got;
      const base = analysePcm(pcm, sr);
      const factor = Math.max(1, Math.round(sr / RATE));
      const box = decimateBoxcar(pcm, factor);
      const fir = decimateFir(pcm, factor);
      const rate = sr / factor;
      const a = pitchSpec(box, rate, 4096, 2048);
      const b = pitchSpec(fir, rate, 4096, 2048);
      const c = pitchSpec(fir, rate, 8192, 2048);
      out.tracks[row.id] = {
        deezerId: got.deezerId,
        deezerTitle: got.label,
        sampleRate: sr,
        rate,
        baseline: { camelot: base?.camelot, keyConfidence: base?.keyConfidence, bpm: base?.bpm, features: base?.features },
        tuningCents: tuningCents(fir, rate),
        extras: extras(pcm, sr),
        spec: {
          box4096: { frames: a.frames, b64: b64(a.data) },
          fir4096: { frames: b.frames, b64: b64(b.data) },
          fir8192: { frames: c.frames, b64: b64(c.data) },
        },
      };
      writeFileSync(outFile, JSON.stringify(out));
      const same = base?.camelot === row.local?.camelot ? 'same' : `DIFF (bench ${row.local?.camelot})`;
      console.log(`[${i + 1}/${todo.length}] ${row.id}: ${got.label}  key ${base?.camelot} ${same}`);
    } catch (err) {
      console.log(`[${i + 1}] ${row.id}: ${(err as Error).message}`);
      if (guard.stopped.size || guard.refused.deezer) break;
    }
  }
  console.log(`deezer calls this run: ${gate.count - startCount} (today ${gate.count}/${DEEZER_DAILY_CAP})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
