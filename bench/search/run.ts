import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MergedSearchResponse, SearchProvider, SearchResult } from '../../src/lib/search/types';
import {
  BenchThrottled,
  RequestGate,
  budgetFor,
  dayKey,
  degradedSummary,
  filterAllowed,
  guardProvider,
  isRateLimited,
  loadDailyCounts,
  mergedQueryGapMs,
  missingRequired,
  requiredProviders,
  runStatus,
  saveDailyCounts,
  selectSingleProviders,
  type Breaker,
} from './guard';
import { hitDetail, versionRank, percentile, type BenchTrack, type BenchVersionCase } from './score';

try {
  (process as any).loadEnvFile?.('.env');
} catch {
  // no .env: unconfigured providers are skipped below
}

const here = __dirname;
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
if (dryRun) {
  // the merger consults the app's persisted breaker; a dry run must neither read nor write the real one
  process.env.SETARCHITECT_DATA_DIR = mkdtempSync(join(tmpdir(), 'bench-dry-'));
}
const named = argv.filter((a) => !a.startsWith('--'));
const DEFAULT_GAP_MS = 340; // <= 3 req/s
const GAP_MS: Record<string, number> = { itunes: 3100, spotify: 340, deezer: 340, musicbrainz: 1100 };
const gates = new Map<string, RequestGate>();
let breaker: Breaker | null = null;
const tracks: BenchTrack[] = JSON.parse(readFileSync(join(here, 'tracks.json'), 'utf8'));
const versions: BenchVersionCase[] = JSON.parse(readFileSync(join(here, 'versions.json'), 'utf8'));

interface Timing {
  stage1Ms: number;
  totalMs: number;
  stage2: boolean;
}

interface Target {
  name: string;
  /** Per-query degraded provider lists, filled by the merged target. */
  degraded?: string[][];
  /** Per-query providers the harness itself refused to call (budget, pacing, breaker). */
  throttled?: string[][];
  /** Minimum gap between queries. */
  gapMs?: number;
  /** Merged target: stage timings reported by mergedSearch via onTiming. */
  timings?: Timing[];
  participating?: string[];
  requiredMissing?: string[];
  run(query: string): Promise<Array<{ artist: string; title?: string; baseTitle?: string; version: SearchResult['version']; durationMs?: number; provider?: string; providers?: string[] }>>;
}

const stubProvider = (name: SearchResult['provider']): SearchProvider => ({
  name,
  configured: () => true,
  async search(q) {
    await sleep(25);
    return [
      {
        provider: name,
        providerId: `stub-${q}`,
        artist: 'Stub Artist',
        artists: ['Stub Artist'],
        title: q,
        version: { baseTitle: q, kind: 'original', featuring: [] },
        durationMs: 200_000,
      },
    ];
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryImport(path: string): Promise<any | null> {
  try {
    return await import(path);
  } catch {
    return null;
  }
}

async function loadTargets(): Promise<{ targets: Target[]; skipped: string[] }> {
  const targets: Target[] = [];
  const skipped: string[] = [];
  const prov = await tryImport('../../src/lib/search/providers/index');
  let list: SearchProvider[] =
    typeof prov?.getProviders === 'function' ? prov.getProviders()
    : Array.isArray(prov?.searchProviders) ? prov.searchProviders
    : Array.isArray(prov?.providers) ? prov.providers
    : Array.isArray(prov?.default) ? prov.default
    : [];
  if (!prov || list.length === 0) console.log('providers not available (src/lib/search/providers/index.ts missing or empty)');
  list = filterAllowed(list, process.env.SEARCH_PROVIDERS);
  if (dryRun) list = list.map((p) => stubProvider(p.name));

  breaker = dryRun ? null : await tryImport('../../src/lib/search/breaker');
  if (!breaker && !dryRun) console.log('breaker.ts not available; cooldowns will not be shared with the app');

  let persist = () => {};
  let today: Record<string, number> = {};
  if (!dryRun) {
    const dd = await tryImport('../../src/lib/dataDir');
    const dailyFile: string | null = dd ? dd.dataDir('search', 'bench-requests.json') : null;
    const day = dayKey();
    const store = {
      read: () => (dailyFile && existsSync(dailyFile) ? readFileSync(dailyFile, 'utf8') : null),
      write: (t: string) => dailyFile && writeFileSync(dailyFile, t),
    };
    today = loadDailyCounts(store, day);
    persist = () => saveDailyCounts(store, day, Object.fromEntries([...gates].map(([k, g]) => [k, g.count])));
  }
  for (const p of list) gates.set(p.name, new RequestGate(budgetFor(p.name), today[p.name] ?? 0, persist));

  const wantedNames = named.length ? named : ['merged'];

  // single-provider targets: only when named explicitly
  const { run, skipped: sk } = selectSingleProviders(list, breaker);
  for (const k of sk) {
    if (wantedNames.includes(k.name)) skipped.push(`${k.name}: ${k.reason}${k.until ? ` until ${new Date(k.until).toLocaleString()}` : ''}`);
  }
  for (const p of run) {
    if (!wantedNames.includes(p.name)) continue;
    const g = guardProvider(p, { gate: gates.get(p.name)!, breaker, gapMs: 0 });
    targets.push({
      name: p.name,
      gapMs: dryRun ? 0 : GAP_MS[p.name] ?? DEFAULT_GAP_MS,
      run: async (q) => (await g.search(q, { limit: 10 })).map((r: SearchResult) => ({ ...r, baseTitle: r.version.baseTitle })),
    });
  }

  if (wantedNames.includes('merged')) {
    const merge = await tryImport('../../src/lib/search/merge');
    const fn: ((q: string, o?: { providers?: SearchProvider[]; onTiming?: (t: Timing) => void }) => Promise<MergedSearchResponse>) | undefined =
      merge?.mergedSearch ?? merge?.searchMerged ?? merge?.search ?? merge?.default;
    if (typeof fn !== 'function') {
      skipped.push('merged: merge.ts missing or exports no mergedSearch');
    } else {
      const degraded: string[][] = [];
      const throttled: string[][] = [];
      const timings: Timing[] = [];
      let now = new Set<string>();
      const usable = list.filter((p) => p.configured() && (breaker?.cooldownUntil(p.name) ?? 0) <= Date.now());
      // rate is enforced per query (outer gap), not per call: the merger may legitimately call a provider twice
      const wrapped = usable.map((p) =>
        guardProvider(p, { gate: gates.get(p.name)!, breaker, gapMs: 0, onThrottle: (e) => now.add(e.provider) }),
      );
      const participating = wrapped.map((p) => p.name);
      targets.push({
        name: 'merged',
        degraded,
        throttled,
        timings,
        participating,
        requiredMissing: missingRequired(requiredProviders(), participating),
        gapMs: dryRun ? 0 : mergedQueryGapMs(participating, GAP_MS),
        run: async (q) => {
          now = new Set();
          const res = await fn(q, { providers: wrapped, onTiming: (t) => timings.push(t) });
          degraded.push((res.degraded ?? []).filter((n) => !now.has(n)));
          throttled.push([...now]);
          return res.hits.map((h) => ({ ...h, baseTitle: h.baseTitle }));
        },
      });
    }
  }

  console.log('--- pre-flight plan ---');
  console.log(`mode: ${dryRun ? 'DRY RUN (all providers stubbed, zero network, nothing persisted)' : 'live'}`);
  console.log(`targets: ${wantedNames.join(', ')}${named.length ? '' : ' (default: merged only)'}`);
  console.log(`providers (SEARCH_PROVIDERS=${process.env.SEARCH_PROVIDERS ?? 'all'}): ${list.map((p) => `${p.name}${p.configured() ? '' : '(unconfigured)'}`).join(', ') || 'none'}`);
  console.log(`required for merged (BENCH_REQUIRED): ${requiredProviders().join(', ') || 'none'}`);
  console.log(`budgets, used today / budget: ${list.map((p) => `${p.name} ${gates.get(p.name)!.count}/${budgetFor(p.name) ?? '-'}`).join(', ')}`);
  for (const k of skipped) console.log(`skipped ${k}`);
  for (const t of targets) {
    if (t.participating) console.log(`merged participating: ${t.participating.join(', ') || 'none'}${t.requiredMissing?.length ? `  MISSING REQUIRED: ${t.requiredMissing.join(', ')}` : ''}; query gap ${t.gapMs} ms`);
  }
  return { targets, skipped };
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);

const sumGates = () => [...gates.values()].reduce((a, g) => a + g.count, 0);

async function runTarget(t: Target) {
  const mergedStart = sumGates();
  const lat: number[] = [];
  let last = 0;
  const startCount = gates.get(t.name)?.count ?? 0;
  let budgetExceeded = false;
  let rateLimitedUntil = 0;
  const timed = async (q: string) => {
    if (budgetExceeded || rateLimitedUntil) return { res: [], error: 'target aborted' };
    const wait = last + (t.gapMs ?? DEFAULT_GAP_MS) - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const t0 = performance.now();
    try {
      const res = await t.run(q);
      lat.push(performance.now() - t0);
      return { res, error: undefined as string | undefined };
    } catch (e) {
      lat.push(performance.now() - t0);
      if (e instanceof BenchThrottled && t.name !== 'merged') {
        budgetExceeded = true;
        console.log(`${t.name}: ${e.message}; aborting target`);
        return { res: [], error: 'target aborted' };
      }
      if (isRateLimited(t.name, e)) {
        breaker?.recordFailure(t.name, e);
        rateLimitedUntil = breaker?.cooldownUntil(t.name) || Date.now() + 5 * 60_000;
        console.log(`${t.name}: rate-limited (HTTP ${(e as any).status}); aborting target, no retry. Unlocks ${new Date(rateLimitedUntil).toLocaleString()}`);
      }
      return { res: [], error: String((e as Error).message ?? e) };
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

  const trackRows: Array<{ id: string; bucket: string; hit: boolean; rank?: number; via?: string; matched?: Seen; top3?: Seen[]; error?: string }> = [];
  for (const tr of tracks) {
    const { res, error } = await timed(tr.query);
    const d = hitDetail(tr, res);
    trackRows.push({
      id: tr.id, bucket: tr.bucket, hit: d !== null, error,
      ...(d ? { rank: d.rank + 1, via: d.via, matched: seen(res[d.rank]) } : { top3: res.slice(0, 3).map(seen) }),
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
    requests: t.name === 'merged' ? sumGates() - mergedStart : (gates.get(t.name)?.count ?? 0) - startCount,
    degraded: '',
    throttledByBench: '',
    secondaryOnlyHits: 0,
    extrasHits: 0,
    participating: t.participating?.join(', ') ?? '',
    stage1P50: 'n/a' as string | number,
    stage1P95: 'n/a' as string | number,
    totalP50: 'n/a' as string | number,
    totalP95: 'n/a' as string | number,
    stage2Queries: 'n/a' as string | number,
    status: 'ok',
  };
  if (t.timings?.length) {
    summary.stage1P50 = Math.round(percentile(t.timings.map((x) => x.stage1Ms), 50));
    summary.stage1P95 = Math.round(percentile(t.timings.map((x) => x.stage1Ms), 95));
    summary.totalP50 = Math.round(percentile(t.timings.map((x) => x.totalMs), 50));
    summary.totalP95 = Math.round(percentile(t.timings.map((x) => x.totalMs), 95));
    summary.stage2Queries = t.timings.filter((x) => x.stage2).length;
  }
  const dg = t.degraded ? degradedSummary(t.degraded) : { text: '', invalid: [] as string[] };
  summary.degraded = dg.text;
  const secondary = trackRows.filter((r) => r.via?.startsWith('subset-secondary-only'));
  summary.secondaryOnlyHits = secondary.length;
  const withExtras = trackRows.filter((r) => r.via?.endsWith('+extras'));
  summary.extrasHits = withExtras.length;
  if (withExtras.length) {
    console.log(`${t.name}: ${withExtras.length} hit(s) with extra uncredited artists to inspect by hand:`);
    for (const r of withExtras) console.log(`  ${r.id} [${r.via}] <- ${r.matched?.artist} / ${r.matched?.title}`);
  }
  if (secondary.length) {
    console.log(`${t.name}: ${secondary.length} subset-secondary-only hit(s) to inspect by hand:`);
    for (const r of secondary) console.log(`  ${r.id} <- ${r.matched?.artist} / ${r.matched?.title}`);
  }
  if (t.throttled) summary.throttledByBench = degradedSummary(t.throttled).text;
  const erroredN = summary.erroredQueries;
  summary.status = runStatus({
    degradedInvalid: dg.invalid,
    errored: erroredN,
    total: tracks.length + versions.length,
    budgetExceeded,
    rateLimitedUntil: rateLimitedUntil || undefined,
    requiredMissing: t.requiredMissing,
    throttledPartial: t.throttled ? degradedSummary(t.throttled).invalid : [],
  });
  if (!dryRun) {
    const dir = join(here, 'results');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(dir, `${stamp}-${t.name}.json`), JSON.stringify({ summary, trackRows, versionRows }, null, 2));
  }
  return summary;
}

async function main() {
  console.log(`bench: ${tracks.length} tracks, ${versions.length} version cases`);
  const { targets, skipped } = await loadTargets();
  const rows: Array<Record<string, unknown>> = skipped.map((k) => ({ target: k.split(':')[0], status: `NOT RUN (${k})` }));
  for (const t of targets) {
    if (t.requiredMissing?.length && !dryRun) {
      rows.push({ target: t.name, status: runStatus({ degradedInvalid: [], errored: 0, total: 1, budgetExceeded: false, requiredMissing: t.requiredMissing }) + ' - NOT RUN' });
      continue;
    }
    console.log(`running ${t.name}...`);
    rows.push(await runTarget(t));
  }
  if (rows.length === 0) console.log('Nothing to run.');
  else console.table(rows);
  console.log(`today's request totals (${dayKey()}${dryRun ? ', dry run, not persisted' : ''}): ${[...gates].map(([k, g]) => `${k} ${g.count}/${budgetFor(k) ?? '-'}`).join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
