/**
 * U2 tuning, offline: compares key-estimation variants on the stored pitch spectrograms against the bench's reference
 * keys (ReccoBeats; never preview-analysis). Model selection is nested in leave-one-out, so the reported numbers are
 * held out: for each labelled track the best config is chosen on the other tracks and then scored on it.
 *
 *   npx tsx bench/data/tune/key.ts <bench-result.json> [--quick: ablations only]
 */
import { readFileSync } from 'node:fs';
import { dataDir } from '../../../src/lib/dataDir';
import { toCamelot } from '../../../src/lib/sources/camelot';
import { keyAgreement, LOCAL_SOURCE, type DataRow } from '../score';
import { MIDI_LO, NBINS, SUB, decodeSpec, type FeatureFile, type SpecName, type TrackFeatures } from './common';

const PROFILES: Record<string, { major: number[]; minor: number[] }> = {
  krumhansl: {
    major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  },
  temperley: {
    major: [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
    minor: [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
  },
  // constructed, not sourced: scale degrees 1, tonic triad 2 (major scale / natural minor)
  diatonic: {
    major: [2, 0, 1, 0, 2, 1, 0, 2, 0, 1, 0, 1],
    minor: [2, 0, 1, 2, 0, 1, 0, 2, 1, 0, 1, 0],
  },
};

export interface KeyConfig {
  spec: SpecName;
  norm: 'sum' | 'mean';
  hpss: boolean;
  mag: 'lin' | 'log';
  whiten: boolean;
  range: [number, number];
  tuning: boolean;
  tonal: boolean;
  /** each frame's chroma normalised to sum 1 before accumulating (equal weight per frame, not per loudness) */
  frameNorm: boolean;
  profile: string;
  minorBias: number;
}

const BASELINE: KeyConfig = {
  spec: 'box4096', norm: 'sum', hpss: false, mag: 'lin', whiten: false, range: [110, 4000],
  tuning: false, tonal: false, frameNorm: false, profile: 'krumhansl', minorBias: 0,
};

/** What nested LOO picked in every fold (2026-11-02) and key.ts now ships. */
const CHOSEN: KeyConfig = { ...BASELINE, spec: 'fir4096', norm: 'mean', whiten: true, profile: 'temperley' };

const hzOf =(s: number) => 440 * 2 ** ((MIDI_LO + s / SUB - 69) / 12);

/** How many STFT bins the extractor summed into each pitch bin (for 'mean' normalisation). */
const countCache = new Map<string, Float64Array>();
function binCounts(rate: number, frame: number): Float64Array {
  const id = `${rate}/${frame}`;
  let c = countCache.get(id);
  if (c) return c;
  c = new Float64Array(NBINS);
  const binHz = rate / frame;
  for (let k = 1; k < frame / 2; k++) {
    const s = Math.round((12 * Math.log2((k * binHz) / 440) + 69 - MIDI_LO) * SUB);
    if (s >= 0 && s < NBINS) c[s]++;
  }
  countCache.set(id, c);
  return c;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Soft (Wiener) harmonic mask: time-median (harmonic) vs pitch-median (percussive) of the spectrogram. */
function hpssHarmonic(X: Float64Array[], kt = 8, kf = 2 * SUB): Float64Array[] {
  const F = X.length;
  const out = X.map((r) => new Float64Array(r.length));
  for (let f = 0; f < F; f++) {
    for (let s = 0; s < NBINS; s++) {
      const t: number[] = [];
      for (let g = Math.max(0, f - kt); g <= Math.min(F - 1, f + kt); g++) t.push(X[g][s]);
      const p: number[] = [];
      for (let z = Math.max(0, s - kf); z <= Math.min(NBINS - 1, s + kf); z++) p.push(X[f][z]);
      const h = median(t);
      const q = median(p);
      out[f][s] = h + q > 0 ? (X[f][s] * h * h) / (h * h + q * q) : 0;
    }
  }
  return out;
}

const specCache = new Map<string, Float64Array[]>();
function baseSpec(id: string, t: TrackFeatures, cfg: KeyConfig): Float64Array[] {
  const k = `${id}/${cfg.spec}/${cfg.norm}/${cfg.hpss}`;
  let X = specCache.get(k);
  if (X) return X;
  const counts = binCounts(t.rate, cfg.spec === 'fir8192' ? 8192 : 4096);
  X = decodeSpec(t.spec[cfg.spec]).map((fr) => {
    const r = new Float64Array(NBINS);
    for (let s = 0; s < NBINS; s++) r[s] = cfg.norm === 'mean' ? (counts[s] ? fr[s] / counts[s] : 0) : fr[s];
    return r;
  });
  if (cfg.hpss) X = hpssHarmonic(X);
  specCache.set(k, X);
  return X;
}

export function chromaFor(id: string, t: TrackFeatures, cfg: KeyConfig): Float64Array {
  let X = baseSpec(id, t, cfg);
  if (cfg.mag === 'log') {
    let max = 0;
    for (const r of X) for (const v of r) max = Math.max(max, v);
    X = X.map((r) => r.map((v) => Math.log1p((1000 * v) / (max || 1))));
  }
  if (cfg.whiten) {
    const W = SUB * 6; // half-octave either side
    X = X.map((r) => {
      const o = new Float64Array(NBINS);
      for (let s = 0; s < NBINS; s++) {
        let acc = 0;
        let n = 0;
        for (let z = Math.max(0, s - W); z <= Math.min(NBINS - 1, s + W); z++) {
          acc += r[z];
          n++;
        }
        o[s] = Math.max(0, r[s] - acc / n);
      }
      return o;
    });
  }
  const shift = cfg.tuning ? Math.round(t.tuningCents / (100 / SUB)) : 0;
  const pc = new Int8Array(NBINS).fill(-1);
  for (let s = 0; s < NBINS; s++) {
    const hz = hzOf(s - shift);
    if (hz >= cfg.range[0] && hz <= cfg.range[1]) pc[s] = (((MIDI_LO + Math.round((s - shift) / SUB)) % 12) + 12) % 12;
  }
  const chroma = new Float64Array(12);
  for (const r of X) {
    const c = new Float64Array(12);
    let sum = 0;
    for (let s = 0; s < NBINS; s++) if (pc[s] >= 0) {
      c[pc[s]] += r[s];
      sum += r[s];
    }
    if (!(sum > 0)) continue;
    let w = 1;
    if (cfg.tonal) {
      let h = 0;
      for (const v of c) if (v > 0) h -= (v / sum) * Math.log(v / sum);
      w = 1 - h / Math.log(12);
    }
    if (cfg.frameNorm) w /= sum;
    for (let i = 0; i < 12; i++) chroma[i] += w * c[i];
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

export function keyOf(chroma: Float64Array, profile: string, minorBias: number): { camelot: string; r: number } {
  const p = PROFILES[profile];
  let best = { tonic: 0, mode: 1, r: -Infinity, score: -Infinity };
  for (const [mode, table] of [[1, p.major], [0, p.minor]] as const) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const r = pearson(chroma, table.map((_, i) => table[(i - tonic + 12) % 12]));
      const score = r + (mode === 0 ? minorBias : 0);
      if (score > best.score) best = { tonic, mode, r, score };
    }
  }
  return { camelot: toCamelot(best.tonic, best.mode)!, r: best.r };
}

type Pred = { camelot: string; r: number };
interface Eval {
  /** threshold giving >= 80% yield over every analysed track */
  thr: number;
  preds: Map<string, Pred>;
}

const MIN_YIELD = 0.8;

let cachedFor = '';
function evaluate(ids: string[], feats: FeatureFile, cfg: KeyConfig): Eval {
  const base = `${cfg.spec}/${cfg.norm}/${cfg.hpss}`;
  if (base !== cachedFor) specCache.clear(); // ~50 MB per variant: keep one
  cachedFor = base;
  const preds = new Map<string, Pred>();
  for (const id of ids) preds.set(id, keyOf(chromaFor(id, feats.tracks[id], cfg), cfg.profile, cfg.minorBias));
  // unsupervised: the confidence threshold is the 20th percentile over all tracks (no reference labels used)
  const rs = [...preds.values()].map((p) => p.r).sort((a, b) => a - b);
  const thr = rs[Math.floor((1 - MIN_YIELD) * rs.length)] ?? 0;
  return { thr, preds };
}

type Dist = { exact: number; relative: number; fifth: number; miss: number; none: number };
function dist(refs: Array<[string, string]>, ev: Eval): Dist {
  const d: Dist = { exact: 0, relative: 0, fifth: 0, miss: 0, none: 0 };
  for (const [id, ref] of refs) {
    const p = ev.preds.get(id);
    if (!p || p.r < ev.thr) d.none++;
    else d[keyAgreement(ref, p.camelot)]++;
  }
  return d;
}
const hits = (d: Dist) => d.exact + d.relative;
const fmtD = (d: Dist) => {
  const n = d.exact + d.relative + d.fifth + d.miss;
  const pct = (x: number) => `${((100 * x) / Math.max(1, n)).toFixed(0)}%`;
  return `ex ${d.exact} rel ${d.relative} 5th ${d.fifth} miss ${d.miss} none ${d.none} | hit ${pct(hits(d))} miss ${pct(d.miss)} (n=${n})`;
};

/** For a 'miss': parallel mode (same tonic), fifth+mode (±1 number, other letter), two fifths (±2), or other. */
function missKind(a: string, b: string): string {
  const pa = /^(\d+)([AB])$/.exec(a)!;
  const pb = /^(\d+)([AB])$/.exec(b)!;
  const d = Math.min((Number(pa[1]) - Number(pb[1]) + 12) % 12, (Number(pb[1]) - Number(pa[1]) + 12) % 12);
  const same = pa[2] === pb[2];
  if (!same && d === 3) {
    // 8A (A minor) vs 11B (A major): same tonic
    const minor = pa[2] === 'A' ? Number(pa[1]) : Number(pb[1]);
    const major = pa[2] === 'B' ? Number(pa[1]) : Number(pb[1]);
    if ((minor + 3 - 1) % 12 + 1 === major) return 'parallel';
  }
  if (!same && d === 1) return 'fifth+mode';
  if (same && d === 2) return 'two-fifths';
  return `other(d${d}${same ? '' : '+mode'})`;
}

function name(c: KeyConfig): string {
  const diff = (Object.keys(c) as Array<keyof KeyConfig>).filter((k) => JSON.stringify(c[k]) !== JSON.stringify(BASELINE[k]));
  return diff.map((k) => `${k}=${JSON.stringify(c[k])}`).join(' ') || 'baseline';
}

function main(): void {
  const benchFile = process.argv[2];
  if (!benchFile) throw new Error('usage: key.ts <bench-result.json>');
  const bench = JSON.parse(readFileSync(benchFile, 'utf8')) as { rows: DataRow[] };
  const feats = JSON.parse(readFileSync(dataDir('bench', 'u2-features.json'), 'utf8')) as FeatureFile;
  const ids = Object.keys(feats.tracks);
  const refs: Array<[string, string]> = bench.rows
    .filter((r) => feats.tracks[r.id] && r.fields.camelot !== undefined && r.sources.camelot !== LOCAL_SOURCE)
    .map((r) => [r.id, String(r.fields.camelot)]);
  const consistent = ids.filter((id) => feats.tracks[id].baseline.camelot === bench.rows.find((r) => r.id === id)?.local?.camelot).length;
  console.log(`tracks ${ids.length}, labelled ${refs.length}, baseline key identical to bench run on ${consistent}/${ids.length}`);

  // the shipped analyser as stored (threshold 0.5), for reference
  const shipped: Dist = { exact: 0, relative: 0, fifth: 0, miss: 0, none: 0 };
  for (const [id, ref] of refs) {
    const b = feats.tracks[id].baseline.camelot;
    if (!b) shipped.none++;
    else shipped[keyAgreement(ref, b)]++;
  }
  const shippedYield = ids.filter((id) => feats.tracks[id].baseline.camelot).length / ids.length;
  console.log(`shipped (thr 0.5, yield ${(100 * shippedYield).toFixed(0)}%): ${fmtD(shipped)}`);

  // one lever at a time against the baseline
  const levers: Array<Partial<KeyConfig>> = [
    {}, { spec: 'fir4096' }, { spec: 'fir8192' }, { norm: 'mean' }, { hpss: true }, { mag: 'log' }, { whiten: true },
    { range: [55, 4000] }, { range: [110, 2000] }, { range: [220, 4000] }, { tuning: true }, { tonal: true }, { frameNorm: true },
    { profile: 'temperley' }, { profile: 'diatonic' }, { minorBias: 0.03 }, { minorBias: 0.06 },
  ];
  console.log('\nablation (one lever vs baseline, threshold at 80% yield; all labelled tracks, NOT held out):');
  for (const l of levers) {
    const cfg = { ...BASELINE, ...l };
    const ev = evaluate(ids, feats, cfg);
    console.log(`  ${name(cfg).padEnd(36)} thr ${ev.thr.toFixed(2)}  ${fmtD(dist(refs, ev))}`);
  }
  console.log('\nablation around the shipped config (NOT held out):');
  const around: Array<Partial<KeyConfig>> = [
    {}, { spec: 'box4096' }, { norm: 'sum' }, { whiten: false }, { profile: 'krumhansl' }, { profile: 'diatonic' },
    { hpss: true }, { tuning: true }, { range: [55, 4000] }, { range: [110, 2000] }, { range: [80, 4000] }, { mag: 'log' },
  ];
  for (const l of around) {
    const cfg = { ...CHOSEN, ...l };
    const ev = evaluate(ids, feats, cfg);
    console.log(`  ${name(cfg).padEnd(60)} thr ${ev.thr.toFixed(2)}  ${fmtD(dist(refs, ev))}`);
  }

  console.log('\nfixed KEY_MIN_CONFIDENCE sweep for the shipped config:');
  const chosen = evaluate(ids, feats, CHOSEN);
  for (const thr of [0.4, 0.45, 0.48, 0.5, 0.52, 0.55]) {
    const y = [...chosen.preds.values()].filter((p) => p.r >= thr).length / ids.length;
    console.log(`  thr ${thr.toFixed(2)} yield ${(100 * y).toFixed(0)}%  ${fmtD(dist(refs, { thr, preds: chosen.preds }))}`);
  }

  if (process.argv.includes('--quick')) return;

  // grid for nested LOO selection
  const grid: KeyConfig[] = [];
  for (const spec of ['fir4096', 'fir8192'] as SpecName[])
    for (const norm of ['sum', 'mean'] as const)
      for (const hpss of [false, true])
        for (const mag of ['lin', 'log'] as const)
          for (const whiten of [false, true])
            for (const tuning of [false, true])
              for (const profile of ['krumhansl', 'temperley', 'diatonic'])
                for (const frameNorm of [false, true])
                  grid.push({ spec, norm, hpss, mag, whiten, range: [110, 4000], tuning, tonal: false, frameNorm, profile, minorBias: 0 });
  const evals = grid.map((c) => evaluate(ids, feats, c));
  const perTrack = evals.map((ev) => new Map(refs.map(([id, ref]) => {
    const p = ev.preds.get(id)!;
    return [id, p.r < ev.thr ? 'none' : keyAgreement(ref, p.camelot)] as const;
  })));
  const score = (g: number, skip?: string) => {
    let s = 0;
    let m = 0;
    for (const [id] of refs) if (id !== skip) {
      const v = perTrack[g].get(id);
      if (v === 'exact' || v === 'relative') s++;
      if (v === 'miss') m++;
    }
    return s - 0.5 * m; // hits, then fewer misses
  };
  const order = grid.map((_, g) => g).sort((a, b) => score(b) - score(a));
  console.log('\ntop configs on all labelled tracks (in-sample):');
  for (const g of order.slice(0, 10)) console.log(`  ${name(grid[g]).padEnd(70)} ${fmtD(dist(refs, evals[g]))}`);

  const held: Dist = { exact: 0, relative: 0, fifth: 0, miss: 0, none: 0 };
  const picks = new Map<string, number>();
  for (const [id] of refs) {
    let best = 0;
    for (let g = 1; g < grid.length; g++) if (score(g, id) > score(best, id)) best = g;
    picks.set(name(grid[best]), (picks.get(name(grid[best])) ?? 0) + 1);
    const v = perTrack[best].get(id)!;
    held[v as keyof Dist]++;
  }
  // what the misses of the in-sample best config look like
  const kinds: Record<string, number> = {};
  for (const [id, ref] of refs) {
    const p = evals[order[0]].preds.get(id)!;
    if (p.r < evals[order[0]].thr || keyAgreement(ref, p.camelot) !== 'miss') continue;
    kinds[missKind(ref, p.camelot)] = (kinds[missKind(ref, p.camelot)] ?? 0) + 1;
  }
  console.log('misses of the top config by relation:', kinds);

  console.log(`\nnested LOO over ${grid.length} configs (held out): ${fmtD(held)}`);
  console.log('configs picked per fold:', [...picks].sort((a, b) => b[1] - a[1]).slice(0, 5));
}

main();
