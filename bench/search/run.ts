import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MergedSearchResponse, SearchProvider, SearchResult } from '../../src/lib/search/types';
import { isHit, versionCorrect, percentile, type BenchTrack, type BenchVersionCase } from './score';

const here = __dirname;
const MIN_GAP_MS = 340; // <= 3 req/s per target
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
      merge.searchMerged ?? merge.mergedSearch ?? merge.search ?? merge.default;
    if (typeof fn !== 'function') console.log('merge module loaded but exports no search function (searchMerged/mergedSearch/search)');
    else targets.push({ name: 'merged', run: async (q) => (await fn(q)).hits.map((h) => ({ ...h, baseTitle: h.baseTitle })) });
  }
  return targets;
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);

async function runTarget(t: Target) {
  const lat: number[] = [];
  let last = 0;
  const timed = async (q: string) => {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const t0 = performance.now();
    try {
      const res = await t.run(q);
      lat.push(performance.now() - t0);
      return { res, error: undefined as string | undefined };
    } catch (e) {
      lat.push(performance.now() - t0);
      return { res: [], error: String((e as Error).message ?? e) };
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

  const hits = (b?: string) => trackRows.filter((r) => (!b || r.bucket === b) && r.hit).length;
  const total = (b?: string) => trackRows.filter((r) => !b || r.bucket === b).length;
  const summary = {
    target: t.name,
    hitOverall: pct(hits(), total()),
    hitClassic: pct(hits('classic'), total('classic')),
    hitRecent: pct(hits('recent'), total('recent')),
    versionCorrect: pct(versionRows.filter((r) => r.ok).length, versionRows.length),
    p50Ms: Math.round(percentile(lat, 50)),
    p95Ms: Math.round(percentile(lat, 95)),
    errors: [...trackRows, ...versionRows].filter((r) => r.error).length,
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
    console.log(`running ${t.name}...`);
    rows.push(await runTarget(t));
  }
  console.table(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
