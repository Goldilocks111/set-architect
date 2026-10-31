import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MergedSearchResponse, SearchProvider, SearchResult } from '../../src/lib/search/types';
import { isHit, versionCorrect, percentile, type BenchTrack, type BenchVersionCase } from './score';

try {
  (process as any).loadEnvFile?.('.env');
} catch {
  // no .env: unconfigured providers are skipped below
}

const here = __dirname;
const DEFAULT_GAP_MS = 340; // <= 3 req/s
const GAP_MS: Record<string, number> = { itunes: 3100, spotify: 340, deezer: 340, merged: 340 };
const BACKOFF_MS = 60_000;
const tracks: BenchTrack[] = JSON.parse(readFileSync(join(here, 'tracks.json'), 'utf8'));
const versions: BenchVersionCase[] = JSON.parse(readFileSync(join(here, 'versions.json'), 'utf8'));

interface Target {
  name: string;
  run(query: string): Promise<Array<{ artist: string; title?: string; baseTitle?: string; version: SearchResult['version'] }>>;
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
    else targets.push({ name: 'merged', run: async (q) => (await fn(q)).hits.map((h) => ({ ...h, baseTitle: h.baseTitle })) });
  }
  return targets;
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const only = process.argv.slice(2);

async function runTarget(t: Target) {
  const lat: number[] = [];
  let last = 0;
  const timed = async (q: string) => {
    const gap = GAP_MS[t.name] ?? DEFAULT_GAP_MS;
    for (let attempt = 0; ; attempt++) {
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
        if (attempt === 0 && t.name === 'itunes' && (status === 429 || status === 403 || /\b(429|403)\b/.test(msg))) {
          console.log('itunes rate-limited; backing off 60s');
          await sleep(BACKOFF_MS);
          continue;
        }
        return { res: [], error: msg };
      }
    }
  };

  const trackRows: Array<{ id: string; bucket: string; hit: boolean; error?: string }> = [];
  for (const tr of tracks) {
    const { res, error } = await timed(tr.query);
    trackRows.push({ id: tr.id, bucket: tr.bucket, hit: isHit(tr, res), error });
  }
  const versionRows: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const c of versions) {
    const { res, error } = await timed(c.query);
    versionRows.push({ id: c.id, ok: versionCorrect(c, res), error });
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
  };
  const dir = join(here, 'results');
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(join(dir, `${date}-${t.name}.json`), JSON.stringify({ summary, trackRows, versionRows }, null, 2));
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
