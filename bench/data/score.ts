export type Essential = 'bpm' | 'camelot' | 'energy' | 'danceability';
export const ESSENTIALS: Essential[] = ['bpm', 'camelot', 'energy', 'danceability'];

export interface DataRow {
  id: string;
  bucket: 'classic' | 'recent';
  fields: Partial<Record<Essential, number | string>>;
  sources: Record<string, string>;
  latencyMs: number;
  local?: {
    bpm?: number;
    camelot?: string;
    energy?: number;
    danceability?: number;
    ms: number;
    /** Raw inputs for fitting energy/danceability coefficients later. */
    features?: { rmsDb: number; onsetRate: number; centroidHz: number; pulseClarity: number };
    keyConfidence?: number;
  };
}

type Yield = Record<Essential | 'complete', number>;

function yieldOf(rows: DataRow[]): Yield {
  const out = { bpm: 0, camelot: 0, energy: 0, danceability: 0, complete: 0 } as Yield;
  if (rows.length === 0) return out;
  for (const r of rows) {
    let all = true;
    for (const f of ESSENTIALS) {
      if (r.fields[f] !== undefined) out[f]++;
      else all = false;
    }
    if (all) out.complete++;
  }
  for (const k of Object.keys(out) as Array<keyof Yield>) out[k] /= rows.length;
  return out;
}

/** Fraction (0..1) of rows carrying each essential, and all four ("complete"). */
export function yieldTable(rows: DataRow[]): Record<'all' | 'classic' | 'recent', Yield> {
  return {
    all: yieldOf(rows),
    classic: yieldOf(rows.filter((r) => r.bucket === 'classic')),
    recent: yieldOf(rows.filter((r) => r.bucket === 'recent')),
  };
}

function parseCamelot(k: string): { n: number; l: string } | null {
  const m = /^(\d{1,2})([AB])$/i.exec(k.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? { n, l: m[2].toUpperCase() } : null;
}

/** relative = same number, other letter; fifth = adjacent number (wrapping 12<->1), same letter. */
export function keyAgreement(a: string, b: string): 'exact' | 'relative' | 'fifth' | 'miss' {
  const x = parseCamelot(a);
  const y = parseCamelot(b);
  if (!x || !y) return 'miss';
  if (x.n === y.n) return x.l === y.l ? 'exact' : 'relative';
  const d = Math.abs(x.n - y.n);
  return x.l === y.l && (d === 1 || d === 11) ? 'fifth' : 'miss';
}

/** Mean absolute error over [reference, local] pairs; 0 when there are none. */
export function maeEnergy(pairs: Array<[number, number]>): number {
  if (pairs.length === 0) return 0;
  return pairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / pairs.length;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

/** Source label the resolver gives to values it estimated itself from the Deezer preview. */
export const LOCAL_SOURCE = 'preview-analysis';

/** Rows with every field whose source is our own preview analysis removed (inputs untouched). */
export function providersOnly(rows: DataRow[]): DataRow[] {
  return rows.map((r) => ({
    ...r,
    fields: Object.fromEntries(Object.entries(r.fields).filter(([f]) => r.sources[f] !== LOCAL_SOURCE)),
  }));
}

/** Number of essentials each source supplied. */
export function sourceBreakdown(rows: DataRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    for (const f of ESSENTIALS) {
      if (r.fields[f] === undefined) continue;
      const s = r.sources[f] ?? 'unknown';
      out[s] = (out[s] ?? 0) + 1;
    }
  }
  return out;
}

/** BPM agreement within ±2%, allowing half-time and double-time. */
export function bpmAgrees(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  return [1, 0.5, 2].some((m) => Math.abs(a - b * m) / a <= 0.02);
}

/**
 * [reference, local] pairs for one field, using only rows whose reference value came from a real provider
 * (never our own preview analysis, which would compare the analyser with itself).
 */
export function referencePairs<T extends number | string>(
  rows: DataRow[],
  field: Essential,
): { pairs: Array<[T, T]>; bySource: Record<string, number> } {
  const pairs: Array<[T, T]> = [];
  const bySource: Record<string, number> = {};
  for (const r of rows) {
    const ref = r.fields[field];
    const loc = r.local?.[field];
    const src = r.sources[field];
    if (ref === undefined || loc === undefined || src === LOCAL_SOURCE) continue;
    pairs.push([ref as T, loc as T]);
    bySource[src ?? 'unknown'] = (bySource[src ?? 'unknown'] ?? 0) + 1;
  }
  return { pairs, bySource };
}

// ---- pipeline bench (resolveWithStatus end state per track)

/** Spec: an incomplete track must resolve or state why within 60 s. */
export const PIPELINE_LIMIT_MS = 60_000;

export interface PipelineRow {
  id: string;
  bucket: 'classic' | 'recent';
  state: 'complete' | 'incomplete';
  reason?: string;
  missing: Essential[];
  elapsedMs: number;
  pass: boolean;
}

/** Pass = (complete OR incomplete-with-a-stated-reason) within the time limit. */
export function pipelinePass(r: { state: 'complete' | 'incomplete'; reason?: string; elapsedMs: number }): boolean {
  return (r.state === 'complete' || !!r.reason) && r.elapsedMs <= PIPELINE_LIMIT_MS;
}

export function summarizePipeline(rows: PipelineRow[]): {
  n: number;
  passed: number;
  complete: Record<'all' | 'classic' | 'recent', number>;
  reasons: Record<string, number>;
  p50: number;
  p95: number;
} {
  const frac = (rs: PipelineRow[]) => (rs.length ? rs.filter((r) => r.state === 'complete').length / rs.length : 0);
  const reasons: Record<string, number> = {};
  for (const r of rows) if (r.state === 'incomplete') reasons[r.reason ?? 'none'] = (reasons[r.reason ?? 'none'] ?? 0) + 1;
  const elapsed = rows.map((r) => r.elapsedMs);
  return {
    n: rows.length,
    passed: rows.filter((r) => r.pass).length,
    complete: {
      all: frac(rows),
      classic: frac(rows.filter((r) => r.bucket === 'classic')),
      recent: frac(rows.filter((r) => r.bucket === 'recent')),
    },
    reasons,
    p50: percentile(elapsed, 50),
    p95: percentile(elapsed, 95),
  };
}
