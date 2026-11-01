import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../../src/lib/dataDir';
import { RequestGate, dayKey, loadDailyCounts, saveDailyCounts } from '../search/guard';
import { createFetchGuard } from './guardFetch';
import { ESSENTIALS, keyAgreement, maeEnergy, percentile, yieldTable, type DataRow, type Essential } from './score';

try {
  (process as any).loadEnvFile?.('.env');
} catch {
  // no .env: unconfigured providers are skipped by the resolver
}

const here = __dirname;
const argv = process.argv.slice(2);
const limitArg = argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : undefined;

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
  const dailyFile = dataDir('search', 'bench-requests.json');
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
  const { resolveTrack } = await import('../../src/lib/resolver');
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
          if (out) row.local = { bpm: out.bpm, camelot: out.camelot, energy: out.energy, danceability: out.danceability, ms: Date.now() - a0 };
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

  const both = rows.filter((r) => r.local);
  const keyDist = { exact: 0, relative: 0, fifth: 0, miss: 0 };
  const energyPairs: Array<[number, number]> = [];
  for (const r of both) {
    const p = r.fields.camelot;
    if (typeof p === 'string' && r.local?.camelot) keyDist[keyAgreement(p, r.local.camelot)]++;
    if (typeof r.fields.energy === 'number' && r.local?.energy !== undefined) energyPairs.push([r.fields.energy, r.local.energy]);
  }
  const localYield = {
    ...Object.fromEntries(ESSENTIALS.map((f) => [f, both.length ? both.filter((r) => r.local?.[f] !== undefined).length / both.length : 0])),
  } as Record<Essential, number>;

  console.log(`\nSTATUS: ${status}  (n=${rows.length})`);
  console.log('\nYield                 all  classic  recent');
  for (const f of [...ESSENTIALS, 'complete'] as const) {
    console.log(`  ${f.padEnd(14)}  ${fmt(table.all[f]).padStart(6)}  ${fmt(table.classic[f]).padStart(6)}  ${fmt(table.recent[f]).padStart(6)}`);
  }
  console.log(`\nLatency per track: p50 ${p50}ms  p95 ${p95}ms`);
  console.log(`\nLocal analysis on ${both.length} tracks with a Deezer preview${analyseFull ? '' : ' (skipped: analyseFull absent)'}`);
  if (both.length) {
    console.log('  local yield: ' + ESSENTIALS.map((f) => `${f} ${fmt(localYield[f])}`).join('  '));
    console.log(`  key vs provider: ${Object.entries(keyDist).map(([k, v]) => `${k} ${v}`).join('  ')}`);
    console.log(`  energy MAE vs provider (${energyPairs.length} pairs): ${maeEnergy(energyPairs).toFixed(2)}`);
    console.log(`  local ms: p50 ${percentile(both.map((r) => r.local!.ms), 50)}  p95 ${percentile(both.map((r) => r.local!.ms), 95)}`);
  }
  console.log(`\nRequests: ${[...gates].map(([k, g]) => `${k} ${g.count}/${BUDGET[k]}`).join('  ')}`);
  if (stoppedList.length) console.log(`Stopped: ${[...stopped].map(([k, v]) => `${k} (${v})`).join('; ')}`);

  const outFile = join(here, 'results', `${day}.json`);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify({ day, status, stopped: Object.fromEntries(stopped), refused, yield: table, latency: { p50, p95 }, key: keyDist, energyMae: maeEnergy(energyPairs), rows }, null, 2),
  );
  console.log(`\nWrote ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
