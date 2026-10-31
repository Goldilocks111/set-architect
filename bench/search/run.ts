import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MergedSearchResponse, SearchProvider, SearchResult } from '../../src/lib/search/types';
import { hitRank, versionRank, percentile, type BenchTrack, type BenchVersionCase } from './score';

try {
  (process as any).loadEnvFile?.('.env');
} catch {
  // no .env: unconfigured providers are skipped below
}

const here = __dirname;
const DEFAULT_GAP_MS = 340; // <= 3 req/s
const GAP_MS: Record<string, number> = { itunes: 3100, spotify: 340, deezer: 340, merged: 340 };
const BACKOFF_MS = 60_000;
const REQUEST_BUDGET: Record<string, number> = { spotify: 150, deezer: 400, itunes: 150 };
const DEGRADED_INVALID_RATE = 0.1;
const tracks: BenchTrack[] = JSON.parse(readFileSync(join(here, 'tracks.json'), 'utf8'));
const versions: BenchVersionCase[] = JSON.parse(readFileSync(join(here, 'versions.json'), 'utf8'));

interface Target {
  name: string;
  /** Per-query degraded provider lists, filled by the merged target. */
  degraded?: string[][];
  run(query: string): Promise<Array<{ artist: string; title?: string; baseTitle?: string; version: SearchResult['version']; durationMs?: number; provider?: string; providers?: string[] }>>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryImport(path: string): Promise<any | null> {
  try {
    return await import(path);
  } catch {
    return null;
  }
}

async function loadTargets(): Promise<Target[]> {
  const targets: Target[] = [];
  const prov = await tryImport('../../src/lib/search/providers/index');
  if (!prov) {
    console.log('providers not available (src/lib/search/providers/index.ts missing or failed to load); skipping provider targets');
  } else {
    const list: SearchProvider[] =
      typeof prov.getProviders === 'function' ? prov.getProviders()
      : Array.isArray(prov.searchProviders) ? prov.searchProviders
      : Array.isArray(prov.providers) ? prov.providers
      : Array.isArray(prov.default) ? prov.default
      : [];
    if (list.length === 0) console.log('providers module loaded but exposes no providers (expected searchProviders[])');
    console.log(`configured providers: ${list.filter((p) => p.configured()).map((p) => p.name).join(', ') || 'none'}`);
    for (const p of list) {
      if (!p.configured()) {
        console.log(`skipping provider ${p.name}: not configured`);
        continue;
      }
      targets.push({
        name: p.name,
        run: async (q) => (await p.search(q, { limit: 10 })).map((r) => ({ ...r, baseTitle: r.version.baseTitle })),
      });
    }
  }
  const merge = await tryImport('../../src/lib/search/merge');
  if (!merge) {
    console.log('merge.ts not available; skipping merged target');
  } else {
    const fn: ((q: string) => Promise<MergedSearchResponse>) | undefined =
      merge.mergedSearch ?? merge.searchMerged ?? merge.search ?? merge.default;
    if (typeof fn !== 'function') console.log('merge module loaded but exports no search function (searchMerged/mergedSearch/search)');
    else {
      const degraded: string[][] = [];
      targets.push({
        name: 'merged',
        degraded,
        run: async (q) => {
          const res = await fn(q);
          degraded.push(res.degraded ?? []);
          return res.hits.map((h) => ({ ...h, baseTitle: h.baseTitle }));
        },
      });
    }
  }
  return targets;
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const only = process.argv.slice(2);

async function runTarget(t: Target) {
  const lat: number[] = [];
  let last = 0;
  let requests = 0;
  let aborted = false;
  const budget = REQUEST_BUDGET[t.name];
  const timed = async (q: string) => {
    if (aborted) return { res: [], error: 'request budget exceeded' };
    const gap = GAP_MS[t.name] ?? DEFAULT_GAP_MS;
    for (let attempt = 0; ; attempt++) {
      if (budget !== undefined && requests >= budget) {
        aborted = true;
        console.log(`${t.name}: request budget ${budget} exceeded; aborting target`);
        return { res: [], error: 'request budget exceeded' };
      }
      requests++;
      const wait = last + gap - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const t0 = performance.now();
      try {
        const res = await t.run(q);
        lat.push(performance.now() - t0);
        return { res, error: undefined as string | undefined };
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        const status = (e as any)?.status;
        const limited = status === 429 || (t.name === 'itunes' && status === 403) || /\b429\b/.test(msg);
        const maxRetries = t.name === 'itunes' ? 1 : t.name === 'spotify' ? 3 : 0;
        if (limited && attempt < maxRetries) {
          const wait = t.name === 'itunes' ? BACKOFF_MS : 30_000 * (attempt + 1);
          console.log(`${t.name} rate-limited; backing off ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }
        return { res: [], error: msg };
      }
    }
  };

  type Seen = { artist: string; title: string; version?: string; provider?: string; durationMs?: number };
  const seen = (r: Awaited<ReturnType<Target['run']>>[number]): Seen => ({
    artist: r.artist,
    title: r.title ?? r.baseTitle ?? r.version.baseTitle,
    version: r.version.label ?? r.version.kind,
    provider: r.provider ?? r.providers?.join('+'),
    durationMs: r.durationMs,
  });

  const trackRows: Array<{ id: string; bucket: string; hit: boolean; rank?: number; matched?: Seen; top3?: Seen[]; error?: string }> = [];
  for (const tr of tracks) {
    const { res, error } = await timed(tr.query);
    const rank = hitRank(tr, res);
    trackRows.push({
      id: tr.id, bucket: tr.bucket, hit: rank >= 0, error,
      ...(rank >= 0 ? { rank: rank + 1, matched: seen(res[rank]) } : { top3: res.slice(0, 3).map(seen) }),
    });
  }
  const versionRows: Array<{ id: string; ok: boolean; rank?: number; matched?: Seen; top3?: Seen[]; error?: string }> = [];
  for (const c of versions) {
    const { res, error } = await timed(c.query);
    const rank = versionRank(c, res);
    versionRows.push({
      id: c.id, ok: rank >= 0, error,
      ...(rank >= 0 ? { rank: rank + 1, matched: seen(res[rank]) } : { top3: res.slice(0, 3).map(seen) }),
    });
  }

  const ok = (b?: string) => trackRows.filter((r) => (!b || r.bucket === b) && !r.error);
  const hits = (b?: string) => ok(b).filter((r) => r.hit).length;
  const total = (b?: string) => ok(b).length;
  const vOk = versionRows.filter((r) => !r.error);
  const summary = {
    target: t.name,
    hitOverall: pct(hits(), total()),
    hitClassic: pct(hits('classic'), total('classic')),
    hitRecent: pct(hits('recent'), total('recent')),
    versionCorrect: pct(vOk.filter((r) => r.ok).length, vOk.length),
    p50Ms: Math.round(percentile(lat, 50)),
    p95Ms: Math.round(percentile(lat, 95)),
    erroredQueries: [...trackRows, ...versionRows].filter((r) => r.error).length,
    requests,
    degraded: '' as string,
    status: aborted ? 'ABORTED (budget)' : 'ok',
  };
  if (t.degraded) {
    const counts: Record<string, number> = {};
    for (const d of t.degraded) for (const p of d) counts[p] = (counts[p] ?? 0) + 1;
    const n = Math.max(1, t.degraded.length);
    summary.degraded = Object.entries(counts).map(([p, c]) => `${p}:${c}/${n}`).join(' ') || 'none';
    const bad = Object.entries(counts).filter(([, c]) => c / n > DEGRADED_INVALID_RATE).map(([p]) => p);
    if (bad.length) summary.status = `INVALID (degraded >10%: ${bad.join(', ')})`;
  }
  if (summary.status === 'ok' && summary.erroredQueries > 0.1 * (tracks.length + versions.length)) summary.status = 'INVALID (>10% errored)';
  const dir = join(here, 'results');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(dir, `${stamp}-${t.name}.json`), JSON.stringify({ summary, trackRows, versionRows }, null, 2));
  return summary;
}

async function main() {
  console.log(`bench: ${tracks.length} tracks, ${versions.length} version cases`);
  const targets = await loadTargets();
  if (targets.length === 0) {
    console.log('No targets to run. Build src/lib/search/providers/index.ts and/or merge.ts first.');
    return;
  }
  const rows = [];
  for (const t of targets) {
    if (only.length && !only.includes(t.name)) continue;
    console.log(`running ${t.name}...`);
    rows.push(await runTarget(t));
  }
  console.table(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
