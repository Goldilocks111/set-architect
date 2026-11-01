/**
 * U2 tuning, offline: least-squares fits of ENERGY_COEFFS / DANCE_COEFFS on rows whose energy/danceability came from
 * a real provider (never preview-analysis), with leave-one-out MAE for every candidate feature set.
 *
 *   npx tsx bench/data/tune/fit.ts <bench-result.json>
 */
import { existsSync, readFileSync } from 'node:fs';
import { dataDir } from '../../../src/lib/dataDir';
import { LOCAL_SOURCE, type DataRow } from '../score';
import type { FeatureFile } from './common';

type Vec = Record<string, number>;

/** Ridge-stabilised least squares (lambda on standardised features, intercept unpenalised); returns raw-scale coefficients. */
export function fitLinear(X: Vec[], y: number[], names: string[], lambda = 1e-3): Vec {
  const n = X.length;
  const mu = names.map((k) => X.reduce((s, x) => s + x[k], 0) / n);
  const sd = names.map((k, j) => Math.sqrt(X.reduce((s, x) => s + (x[k] - mu[j]) ** 2, 0) / n) || 1);
  const ym = y.reduce((a, b) => a + b, 0) / n;
  const p = names.length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const z = names.map((k, j) => (X[i][k] - mu[j]) / sd[j]);
    for (let r = 0; r < p; r++) {
      b[r] += z[r] * (y[i] - ym);
      for (let c = 0; c < p; c++) A[r][c] += z[r] * z[c];
    }
  }
  for (let r = 0; r < p; r++) A[r][r] += lambda * n;
  // Gaussian elimination
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < p; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const out: Vec = { intercept: ym };
  names.forEach((k, j) => {
    const w = b[j] / A[j][j] / sd[j];
    out[k] = w;
    out.intercept -= w * mu[j];
  });
  return out;
}

const predict = (c: Vec, x: Vec) => Object.keys(c).reduce((s, k) => s + (k === 'intercept' ? c[k] : c[k] * x[k]), 0);
const energyOut = (raw: number) => Math.min(10, Math.max(1, Math.round(raw)));
const danceOut = (raw: number) => Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100;

function loo(X: Vec[], y: number[], names: string[], out: (r: number) => number): number {
  let err = 0;
  for (let i = 0; i < X.length; i++) {
    const c = fitLinear(X.filter((_, j) => j !== i), y.filter((_, j) => j !== i), names);
    err += Math.abs(out(predict(c, X[i])) - y[i]);
  }
  return err / X.length;
}

function main(): void {
  const benchFile = process.argv[2];
  if (!benchFile) throw new Error('usage: fit.ts <bench-result.json>');
  const bench = JSON.parse(readFileSync(benchFile, 'utf8')) as { rows: DataRow[] };
  const featFile = dataDir('bench', 'u2-features.json');
  const feats: FeatureFile = existsSync(featFile) ? JSON.parse(readFileSync(featFile, 'utf8')) : { tracks: {} };

  for (const target of ['energy', 'danceability'] as const) {
    const rows = bench.rows.filter((r) => r.local?.features && r.fields[target] !== undefined && r.sources[target] !== LOCAL_SOURCE);
    const X: Vec[] = rows.map((r) => {
      const f = r.local!.features!;
      const e = feats.tracks[r.id]?.extras;
      const bpm = r.local!.bpm;
      return {
        ...f,
        onsetCapped: Math.min(f.onsetRate, 8),
        club: bpm !== undefined && bpm >= 95 && bpm <= 150 ? 1 : 0,
        ...(e ?? { flatness: NaN, lowRatio: NaN, highRatio: NaN, loudnessRange: NaN }),
      };
    });
    const y = rows.map((r) => Number(r.fields[target]));
    const out = target === 'energy' ? energyOut : danceOut;
    const shipped = rows.reduce((s, r) => s + Math.abs(Number(r.local![target]) - Number(r.fields[target])), 0) / rows.length;
    const mean = y.reduce((a, b) => a + b, 0) / y.length;
    const constMae = loo(X, y, [], out);
    console.log(`\n${target}: n=${rows.length}, mean ${mean.toFixed(2)}; shipped placeholder MAE ${shipped.toFixed(3)}; constant (LOO) ${constMae.toFixed(3)}`);
    const sets: string[][] =
      target === 'energy'
        ? [['rmsDb'], ['highRatio'], ['rmsDb', 'highRatio'], ['rmsDb', 'highRatio', 'lowRatio'], ['rmsDb', 'centroidHz', 'highRatio'], ['rmsDb', 'onsetRate', 'centroidHz'], ['rmsDb', 'centroidHz'], ['rmsDb', 'onsetRate', 'centroidHz', 'pulseClarity'],
           ['rmsDb', 'onsetRate', 'centroidHz', 'loudnessRange'], ['rmsDb', 'onsetRate', 'centroidHz', 'flatness'],
           ['rmsDb', 'onsetRate', 'centroidHz', 'lowRatio', 'highRatio'],
           ['rmsDb', 'onsetRate', 'centroidHz', 'flatness', 'lowRatio', 'highRatio', 'loudnessRange']]
        : [['pulseClarity'], ['pulseClarity', 'onsetCapped', 'club'], ['pulseClarity', 'onsetCapped'], ['pulseClarity', 'club'],
           ['pulseClarity', 'onsetCapped', 'club', 'rmsDb'], ['pulseClarity', 'onsetCapped', 'club', 'lowRatio'],
           ['pulseClarity', 'onsetCapped', 'club', 'centroidHz']];
    for (const names of sets) {
      const ok = X.every((x) => names.every((k) => Number.isFinite(x[k])));
      if (!ok) {
        console.log(`  ${names.join('+').padEnd(70)} skipped (extras missing)`);
        continue;
      }
      const c = fitLinear(X, y, names);
      const fmt = Object.entries(c).map(([k, v]) => `${k} ${Number(v.toPrecision(4))}`).join(', ');
      console.log(`  ${names.join('+').padEnd(70)} LOO MAE ${loo(X, y, names, out).toFixed(3)}   full-fit {${fmt}}`);
    }
  }
}

main();
