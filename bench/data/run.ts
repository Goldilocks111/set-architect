import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { dataDir } from '../../src/lib/dataDir';
import { RequestGate, dayKey, loadDailyCounts, saveDailyCounts } from '../search/guard';
import { createFetchGuard } from './guardFetch';
import { ESSENTIALS, bpmAgrees, keyAgreement, maeEnergy, percentile, pipelinePass, summarizePipeline, type PipelineRow, providersOnly, referencePairs, sourceBreakdown, yieldTable, type DataRow, type Essential } from './score';

try {
  (process as any).loadEnvFile?.('.env');
} catch {
  // no .env: unconfigured providers are skipped by the resolver
}

const here = __dirname;
const argv = process.argv.slice(2);
const limitArg = argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : undefined;
const PIPELINE = argv.includes('--pipeline');

/** Hard per-provider request budgets for one bench run (daily counts shared with the search bench). */
const BUDGET: Record<string, number> = { spotify: 110, deezer: 400, musicbrainz: 200, reccobeats: 200 };
/** Minimum gap between requests per provider (ms). MusicBrainz is 1 req/s. */
const GAP_MS: Record<string, number> = { spotify: 340, deezer: 340, musicbrainz: 1100, reccobeats: 340 };
const gates = new Map<string, RequestGate>();

async function tryImport(path: string): Promise<any | null> {
  try {
    return await import(path);
  } catch {
    return null;
  }
}

const fmt = (x: number) => `${(x * 100).toFixed(0)}%`;

async function main(): Promise<void> {
  const tracks: Array<{ id: string; artist: string; title: string; bucket: 'classic' | 'recent' }> = JSON.parse(
    readFileSync(join(here, '../search/tracks.json'), 'utf8'),
  );
  const subset = LIMIT ? tracks.slice(0, LIMIT) : tracks;

  // static import on purpose: if daily counts can't be shared with the search bench, fail loudly
  // The shared daily counter must stay at the REAL data dir even when --pipeline redirects the rest to a temp dir.
  const realRoot = process.env.SETARCHITECT_DATA_DIR ?? join(os.homedir(), '.setarchitect');
  const dailyFile = PIPELINE ? join(realRoot, 'search', 'bench-requests.json') : dataDir('search', 'bench-requests.json');
  mkdirSync(dirname(dailyFile), { recursive: true });
  if (PIPELINE) {
    // Cold metadata cache: fresh temp dir, set BEFORE the resolver/metadataCache modules are (dynamically) imported.
    // metadataCache resolves its path lazily via dataDir(), but nothing below imports it until after this line.
    process.env.SETARCHITECT_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'setarch-pipeline-'));
    console.log(`pipeline mode: cold cache at ${process.env.SETARCHITECT_DATA_DIR}`);
  }
  const day = dayKey();
  const store = {
    read: () => (existsSync(dailyFile) ? readFileSync(dailyFile, 'utf8') : null),
    write: (t: string) => writeFileSync(dailyFile, t),
  };
  const today = loadDailyCounts(store, day);
  // merge into the shared file: the search bench keeps its own provider keys there
  const persist = () => {
    const fresh = loadDailyCounts(store, day);
    for (const [k, g] of gates) fresh[k] = g.count;
    saveDailyCounts(store, day, fresh);
  };
  for (const [name, budget] of Object.entries(BUDGET)) gates.set(name, new RequestGate(budget, today[name] ?? 0, persist));

  // iTunes IP-blocks us and SoundStat is paid: switch both adapters off for the bench only (same module instances
  // the resolver iterates, so no app code changes).
  const itunes = await import('../../src/lib/sources/itunes');
  const soundstat = await import('../../src/lib/sources/soundstat');
  itunes.itunesAdapter.configured = () => false;
  soundstat.soundstatAdapter.configured = () => false;

  const guard = createFetchGuard({ real: globalThis.fetch, gates, gapMs: GAP_MS });
  const { stopped, refused } = guard;
  globalThis.fetch = guard.fetch;
  const { resolveTrack, resolveWithStatus } = await import('../../src/lib/resolver');
  if (PIPELINE) {
    // No background retries during the run: timers become no-ops (the queue is injected, so it never arms real ones).
    const { setReresolveDeps } = await import('../../src/lib/reresolve');
    setReresolveDeps({ setTimer: () => undefined });
    const { dataDir: dd } = await import('../../src/lib/dataDir');
    if (!dd('index', 'metadata.json').startsWith(process.env.SETARCHITECT_DATA_DIR!)) throw new Error('pipeline: metadata cache not in temp dir');
    if (existsSync(dd('index', 'metadata.json'))) throw new Error('pipeline: metadata cache is not cold');

    const prow: PipelineRow[] = [];
    for (let i = 0; i < subset.length; i++) {
      const t = subset[i];
      const t0 = Date.now();
      let state: PipelineRow['state'] = 'incomplete';
      let reason: string | undefined;
      let missing: PipelineRow['missing'] = [];
      try {
        const track = await resolveWithStatus(t.artist, t.title);
        if (track.unresolved) {
          reason = track.unresolved.reason;
          missing = track.unresolved.missing;
        } else state = 'complete';
      } catch (err) {
        reason = undefined; // a thrown resolve states no reason: fails the pass rule
        console.log(`  ${t.id}: resolve threw (${(err as Error).message})`);
      }
      const elapsedMs = Date.now() - t0;
      const r = { state, reason, elapsedMs };
      prow.push({ id: t.id, bucket: t.bucket, state, ...(reason ? { reason } : {}), missing, elapsedMs, pass: pipelinePass(r) });
      console.log(`[${i + 1}/${subset.length}] ${t.id}: ${state}${reason ? ` (${reason}: ${missing.join(',')})` : ''} ${elapsedMs}ms`);
    }
    const sum = summarizePipeline(prow);
    const stoppedP = [...stopped.keys()];
    const refusedP = Object.keys(refused);
    const statusP = stoppedP.length ? `PARTIAL (rate-limited: ${stoppedP.join(', ')})` : refusedP.length ? `PARTIAL (budget exhausted: ${refusedP.join(', ')})` : sum.passed === sum.n ? 'PASS' : 'FAIL';
    console.log(`\nPIPELINE STATUS: ${statusP}  pass ${sum.passed}/${sum.n}`);
    console.log(`complete: all ${fmt(sum.complete.all)}  classic ${fmt(sum.complete.classic)}  recent ${fmt(sum.complete.recent)}  (target >= 90%, not a gate)`);
    console.log('reasons: ' + (Object.entries(sum.reasons).map(([k, v]) => `${k} ${v}`).join('  ') || 'none'));
    console.log(`elapsed: p50 ${sum.p50}ms  p95 ${sum.p95}ms`);
    console.log(`Requests: ${[...gates].map(([k, g]) => `${k} ${g.count}/${BUDGET[k]}`).join('  ')}`);
    if (stoppedP.length) console.log(`Stopped: ${[...stopped].map(([k, v]) => `${k} (${v})`).join('; ')}`);
    const pOut = join(here, 'results', `${day}-pipeline.json`);
    mkdirSync(dirname(pOut), { recursive: true });
    writeFileSync(pOut, JSON.stringify({ day, status: statusP, stopped: Object.fromEntries(stopped), refused, summary: sum, rows: prow }, null, 2));
    console.log(`\nWrote ${pOut}`);
    return;
  }
  const analysis = await tryImport('../../src/lib/analysis/previewAnalysis');
  const analyseFull: ((b: Uint8Array) => Promise<any>) | null =
    typeof analysis?.analyseFull === 'function' ? analysis.analyseFull : null;
  if (!analyseFull) console.log('analyseFull not exported by previewAnalysis: local column skipped');

  const rows: DataRow[] = [];
  for (let i = 0; i < subset.length; i++) {
    const t = subset[i];
    const t0 = Date.now();
    let track;
    try {
      track = await resolveTrack(t.artist, t.title);
    } catch (err) {
      console.log(`  ${t.id}: resolve failed (${(err as Error).message})`);
      rows.push({ id: t.id, bucket: t.bucket, fields: {}, sources: {}, latencyMs: Date.now() - t0 });
      continue;
    }
    const latencyMs = Date.now() - t0;
    const fields: DataRow['fields'] = {};
    for (const f of ESSENTIALS) if (track[f] !== undefined) fields[f] = track[f];
    const row: DataRow = { id: t.id, bucket: t.bucket, fields, sources: track.sources as Record<string, string>, latencyMs };

    // Only a Deezer preview is analysed (never iTunes: Apple's terms); bytes stay in memory.
    if (analyseFull && track.previewUrl && track.sources.previewUrl === 'deezer') {
      const a0 = Date.now();
      try {
        const res = await fetch(track.previewUrl, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          const out = await analyseFull(new Uint8Array(await res.arrayBuffer()));
          if (out) row.local = { bpm: out.bpm, camelot: out.camelot, energy: out.energy, danceability: out.danceability, ms: Date.now() - a0, features: out.features, keyConfidence: out.keyConfidence };
        }
      } catch {
        // local analysis is best-effort; the column just stays empty for this track
      }
    }
    rows.push(row);
    console.log(`[${i + 1}/${subset.length}] ${t.id}: ${ESSENTIALS.filter((f) => fields[f] !== undefined).join(',') || 'nothing'} (${latencyMs}ms)`);
  }

  // ---- report
  const table = yieldTable(rows);
  const lat = rows.map((r) => r.latencyMs);
  const p50 = percentile(lat, 50);
  const p95 = percentile(lat, 95);
  const stoppedList = [...stopped.keys()];
  const refusedList = Object.keys(refused);
  const status = stoppedList.length
    ? `PARTIAL (rate-limited: ${stoppedList.join(', ')})`
    : refusedList.length
      ? `PARTIAL (budget exhausted: ${refusedList.join(', ')})`
      : 'ok';

  // Accuracy: reference values only (never preview-analysis, which would compare the analyser with itself).
  const both = rows.filter((r) => r.local);
  const refKey = referencePairs<string>(rows, 'camelot');
  const keyDist = { exact: 0, relative: 0, fifth: 0, miss: 0 };
  for (const [ref, loc] of refKey.pairs) keyDist[keyAgreement(ref, loc)]++;
  const refBpm = referencePairs<number>(rows, 'bpm');
  const bpmOk = refBpm.pairs.filter(([r, l]) => bpmAgrees(r, l)).length;
  const refEnergy = referencePairs<number>(rows, 'energy');
  const refDance = referencePairs<number>(rows, 'danceability');
  const energyMae = maeEnergy(refEnergy.pairs);
  const danceMae = maeEnergy(refDance.pairs);
  const provTable = yieldTable(providersOnly(rows));
  const bySource = sourceBreakdown(rows);
  const localYield = {
    ...Object.fromEntries(ESSENTIALS.map((f) => [f, both.length ? both.filter((r) => r.local?.[f] !== undefined).length / both.length : 0])),
  } as Record<Essential, number>;

  console.log(`\nSTATUS: ${status}  (n=${rows.length})`);
  const printYield = (title: string, t: typeof table) => {
    console.log(`\n${title}      all  classic  recent`);
    for (const f of [...ESSENTIALS, 'complete'] as const) {
      console.log(`  ${f.padEnd(14)}  ${fmt(t.all[f]).padStart(6)}  ${fmt(t.classic[f]).padStart(6)}  ${fmt(t.recent[f]).padStart(6)}`);
    }
  };
  printYield('Yield, providers only (excl. preview-analysis)', provTable);
  printYield('Yield, with local analysis', table);
  console.log('\nFields supplied per source: ' + Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join('  '));
  console.log(`\nLatency per track: p50 ${p50}ms  p95 ${p95}ms`);
  console.log(`\nLocal analysis on ${both.length} tracks with a Deezer preview${analyseFull ? '' : ' (skipped: analyseFull absent)'}`);
  if (both.length) {
    console.log('  local yield: ' + ESSENTIALS.map((f) => `${f} ${fmt(localYield[f])}`).join('  '));
    const src = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    console.log(`  key vs reference (n=${refKey.pairs.length}; ${src(refKey.bySource)}): ${Object.entries(keyDist).map(([k, v]) => `${k} ${v}`).join('  ')}`);
    console.log(`  bpm within 2% incl. half/double (n=${refBpm.pairs.length}; ${src(refBpm.bySource)}): ${bpmOk}`);
    console.log(`  energy MAE (n=${refEnergy.pairs.length}; ${src(refEnergy.bySource)}): ${energyMae.toFixed(2)}`);
    console.log(`  danceability MAE (n=${refDance.pairs.length}; ${src(refDance.bySource)}): ${danceMae.toFixed(3)}`);
    console.log(`  local ms: p50 ${percentile(both.map((r) => r.local!.ms), 50)}  p95 ${percentile(both.map((r) => r.local!.ms), 95)}`);
  }
  console.log(`\nRequests: ${[...gates].map(([k, g]) => `${k} ${g.count}/${BUDGET[k]}`).join('  ')}`);
  if (stoppedList.length) console.log(`Stopped: ${[...stopped].map(([k, v]) => `${k} (${v})`).join('; ')}`);

  const outFile = join(here, 'results', `${day}.json`);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify({ day, status, stopped: Object.fromEntries(stopped), refused, yield: table, yieldProvidersOnly: provTable, bySource, reference: { key: { n: refKey.pairs.length, dist: keyDist, bySource: refKey.bySource }, bpm: { n: refBpm.pairs.length, within2pct: bpmOk, bySource: refBpm.bySource }, energy: { n: refEnergy.pairs.length, mae: energyMae, bySource: refEnergy.bySource }, danceability: { n: refDance.pairs.length, mae: danceMae, bySource: refDance.bySource } }, latency: { p50, p95 }, rows }, null, 2),
  );
  console.log(`\nWrote ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
