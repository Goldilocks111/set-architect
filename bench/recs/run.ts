import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir, dataRoot } from '../../src/lib/dataDir';
import { activeCooldowns, degradedProviders, readCooldowns } from '../data/cooldowns';
import { createFetchGuard } from '../data/guardFetch';
import { RequestGate, dayKey, loadDailyCounts, saveDailyCounts } from '../search/guard';
import { TOP_N, makeRunId, writesRating, BENCH_WITHOUT, warmStep, RECS_BUDGET, poolLimitedScenarios, withCrates, auditCrate, buildRatingFile, criterion3Holds, lowCrateScenarios, recsStatus, scoreScenario, isWarmEntry, selectWarmTargets, warmStylesMode, summarizeRecs, uniqueScenarioTracks, validateScenarios, type Scenario, type ScenarioScore } from './score';
import type { Suggestion, Track } from '../../src/types/track';

try {
  (process as any).loadEnvFile?.('.env');
} catch {
  // no .env: unconfigured providers are skipped by the resolver
}

const here = __dirname;
const POOLS: Record<string, Array<{ artist: string; title: string }>> = JSON.parse(readFileSync(join(__dirname, 'pools.json'), 'utf8'));
const limitArg = process.argv.slice(2).find((a) => a.startsWith('--limit='));
const WARM = process.argv.slice(2).includes('--warm');
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : undefined;

const BUDGET = RECS_BUDGET;
/** Minimum gap between requests per provider (ms). MusicBrainz is 1 req/s. */
const GAP_MS: Record<string, number> = { spotify: 340, deezer: 340, lastfm: 250, musicbrainz: 1100, reccobeats: 340 };
const gates = new Map<string, RequestGate>();
const fmt = (x: number) => `${(x * 100).toFixed(0)}%`;

async function main(): Promise<void> {
  // Every scenario rates against the shared crate (all lane pools, minus its own set): a realistic DJ library.
  const scenarios: Scenario[] = withCrates(JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8')), POOLS);
  const errors = validateScenarios(scenarios);
  if (errors.length) {
    console.error(`scenarios.json invalid:\n${errors.join('\n')}`);
    process.exit(1);
  }
  const subset = LIMIT !== undefined ? scenarios.slice(0, LIMIT) : scenarios;

  // Real data dir on purpose: the metadata cache is warm, this measures recommendations, not cold resolution.
  const realRoot = dataRoot();
  const cooldownSeed = readCooldowns(realRoot);
  const active = activeCooldowns(cooldownSeed, ['spotify', 'deezer']);
  if (active.length) {
    console.error(`recs: refusing to start, provider cooldown active for ${active.join(', ')} (see ${join(realRoot, 'search', 'provider-cooldowns.json')})`);
    process.exit(1);
  }

  const day = dayKey();
  const runId = makeRunId(day, new Date()); // names this run's results + rating files and namespaces its A/B key
  const dailyFile = dataDir('search', 'bench-requests.json');
  mkdirSync(dirname(dailyFile), { recursive: true });
  const store = {
    read: () => (existsSync(dailyFile) ? readFileSync(dailyFile, 'utf8') : null),
    write: (t: string) => writeFileSync(dailyFile, t),
  };
  const today = loadDailyCounts(store, day);
  const persist = () => {
    const fresh = loadDailyCounts(store, day);
    for (const [k, g] of gates) fresh[k] = g.count;
    saveDailyCounts(store, day, fresh);
  };
  for (const [name, budget] of Object.entries(BUDGET)) gates.set(name, new RequestGate(budget, today[name] ?? 0, persist));

  // iTunes IP-blocks us and SoundStat is paid: switched off for the bench only.
  const itunes = await import('../../src/lib/sources/itunes');
  const soundstat = await import('../../src/lib/sources/soundstat');
  itunes.itunesAdapter.configured = () => false;
  soundstat.soundstatAdapter.configured = () => false;

  const guard = createFetchGuard({ real: globalThis.fetch, gates, gapMs: GAP_MS });
  globalThis.fetch = guard.fetch;
  const { resolveWithStatus, settleStyles } = await import('../../src/lib/resolver');
  if (WARM) {
    const { getEntry, stylesSettled } = await import('../../src/lib/metadataCache');
    const { isComplete } = await import('../../src/lib/completeness');
    const { trackKeyOf } = await import('../../src/types/track');
    const refs = uniqueScenarioTracks(subset);
    console.log(`warm: ${refs.length} unique tracks across ${subset.length} scenarios`);
    // warm = essentials complete AND styles settled; a complete track with unsettled styles is a free cache hit that re-queues its styles lookup
    const { lastfmTagsDisabled } = await import('../../src/lib/sources/lastfmTags');
    const hasKey = !!process.env.LASTFM_API_KEY?.trim();
    // re-read on every count: a rejected key disables tag lookups mid-run
    const stylesMode = () => warmStylesMode({ hasKey, tagsDisabled: lastfmTagsDisabled() });
    const sayWhy = () => {
      const m = stylesMode();
      if (!m.countStyles) console.log(`warm: ${m.reason}; counting essentials only (lane fit will be blind)`);
    };
    sayWhy();
    const isWarm = (r: { artist: string; title: string }) =>
      isWarmEntry(getEntry(trackKeyOf(r.artist, r.title)), {
        isComplete: (f) => isComplete({ id: 'w', artist: r.artist, title: r.title, sources: {}, ...f } as Track),
        stylesSettled: (e) => !stylesMode().countStyles || stylesSettled(e),
      });
    const { todo } = selectWarmTargets(refs, isWarm);
    console.log(`warm: ${refs.length - todo.length}/${refs.length} warm, resolving ${todo.length}`);
    let skipped = '';
    for (const [i, r] of todo.entries()) {
      // only a stopped/exhausted Deezer or MusicBrainz ends the run; a spent Spotify budget is skipped from then on
      const step = warmStep({ stopped: [...guard.stopped.keys()], refused: Object.keys(guard.refused) });
      if (step.stop) break;
      const now = step.without.filter((p) => !BENCH_WITHOUT.includes(p)).join(',');
      if (now !== skipped) console.log(`warm: continuing without ${(skipped = now)} (budget spent or rate-limited)`);
      const t = await resolveWithStatus(r.artist, r.title, { without: step.without, retryWithout: BENCH_WITHOUT });
      if (i % 150 === 149) await settleStyles(); // keep the styles queue under its cap (200 waiting)
      if (i % 10 === 9) console.log(`  ${i + 1}/${todo.length}${t.unresolved ? ' (last: incomplete)' : ''}`);
    }
    await settleStyles(); // the final count includes the styles lookups queued above
    if (hasKey && lastfmTagsDisabled()) sayWhy(); // disabled during this run
    const left = selectWarmTargets(refs, isWarm);
    const stoppedW = [...guard.stopped.keys()];
    const refusedW = Object.keys(guard.refused);
    const cdW = degradedProviders(cooldownSeed, readCooldowns(realRoot));
    const partial = stoppedW.length || refusedW.length || cdW.length;
    console.log(`warm: ${refs.length - left.todo.length}/${refs.length} warm (essentials + styles)${partial ? ` PARTIAL (stopped ${stoppedW.join(',') || '-'}; budget ${refusedW.join(',') || '-'}; cooldown ${cdW.join(',') || '-'})` : ''}`);
    console.log(`Requests: ${[...gates].map(([k, g]) => `${k} ${g.count}/${BUDGET[k]}`).join('  ')}`);
    return;
  }
  const { getEntry } = await import('../../src/lib/metadataCache');
  const { trackKeyOf } = await import('../../src/types/track');
  const { assembleSuggestions, loadSuggestDeps } = await import('../../src/app/api/suggest/assemble');
  const deps = await loadSuggestDeps();
  // Results must not depend on scenario order: no background crate fills, no scheduled retries; styles settle between scenarios.
  deps.backgroundResolve = undefined;
  deps.queueStyles = undefined; // styles come from --warm, not from lookups one scenario starts for the next
  // The rated pool is the scenario crate + neighbours + similar only: a thin crate is reported PARTIAL, never demo-padded.
  deps.noStarterCrate = true;
  const { setReresolveDeps } = await import('../../src/lib/reresolve');
  setReresolveDeps({ setTimer: () => undefined });

  const toCrate = (r: { artist: string; title: string }, i: number): Track => ({ id: `crate-${i}`, artist: r.artist, title: r.title, sources: {} });
  const results: Array<{ scenario: Scenario; suggestions: Suggestion[]; crate: Array<{ artist: string; title: string; bpm?: number; styles?: string[] }>; lastBpm?: number }> = [];
  const rows: Array<ScenarioScore & Record<string, unknown> & { id: string; crateReady: number; crateSize: number; compliantAvailable: number }> = [];
  for (const [i, sc] of subset.entries()) {
    const t0 = Date.now();
    const playlist: Track[] = [];
    for (const ref of sc.set) playlist.push(await resolveWithStatus(ref.artist, ref.title, { without: BENCH_WITHOUT, retryWithout: BENCH_WITHOUT }));
    await settleStyles(); // the set's own styles lookups land before the engine reads the cache
    const incomplete = playlist.filter((t) => t.unresolved).length;
    const { suggestions, crateKnown, compliantAvailable } = await assembleSuggestions(
      { playlist, template: sc.template, plannedLength: sc.plannedLength, crate: (sc.crate ?? []).map(toCrate) },
      deps,
    );
    await settleStyles(); // candidate lookups started by this scenario finish before the next one starts
    const score = scoreScenario(sc, suggestions);
    const laneKeys = new Set((POOLS[sc.lane] ?? []).map((t) => trackKeyOf(t.artist, t.title)));
    const audit = auditCrate(
      sc.lane,
      (sc.crate ?? []).map((c) => ({
        artist: c.artist, title: c.title, inLanePool: laneKeys.has(trackKeyOf(c.artist, c.title)),
        styles: getEntry(trackKeyOf(c.artist, c.title))?.fields.styles,
      })),
    );
    // the baseline list draws from the same crate, tempo-matched to the last set track that has a BPM
    const lastBpm = [...playlist].reverse().find((t) => t.bpm !== undefined)?.bpm;
    const crateBpm = (sc.crate ?? []).map((c) => {
      const f = getEntry(trackKeyOf(c.artist, c.title))?.fields;
      return { artist: c.artist, title: c.title, bpm: f?.bpm, styles: f?.styles };
    });
    results.push({ scenario: sc, suggestions, crate: crateBpm, lastBpm });
    rows.push({
      id: sc.id, lane: sc.lane, setSize: sc.set.length, incompleteInSet: incomplete, crateReady: crateKnown.length, crateSize: (sc.crate ?? []).length, compliantAvailable, poolLimited: compliantAvailable < TOP_N, ...score, audit, pass: criterion3Holds(score),
      top10: suggestions.slice(0, 10).map((s) => ({ artist: s.track.artist, title: s.track.title, score: s.score, compliant: s.compliant, reasons: s.reasons.map((r) => r.label) })),
      ms: Date.now() - t0,
    });
    console.log(`[${i + 1}/${subset.length}] ${sc.id}: ${score.compliant}/${score.n} compliant, reasons ${score.reasonsOnAll ? 'all' : 'MISSING'}, lane ${fmt(score.laneHitRate)}  ${criterion3Holds(score) ? 'ok' : 'FAIL'}  compliant available ${compliantAvailable}${compliantAvailable < TOP_N ? ' (POOL-LIMITED)' : ''}  crateReady ${crateKnown.length}/${(sc.crate ?? []).length}  tag-confirmed in-lane: ${audit.tagConfirmed}/${(sc.crate ?? []).length}${audit.contradictions.length ? `  CONTRADICTED: ${audit.contradictions.map((c) => `${c.artist} - ${c.title} [${c.styles.join(',')}]`).join('; ')}` : ''}`);
  }

  const sum = summarizeRecs(rows);
  const stopped = [...guard.stopped.keys()];
  const refused = Object.keys(guard.refused);
  const cooldowns = degradedProviders(cooldownSeed, readCooldowns(realRoot));
  const lowCrate = lowCrateScenarios(rows);
  const poolLimited = poolLimitedScenarios(rows);
  let status = recsStatus({ passed: sum.passed, n: sum.n, stopped, refused, cooldowns, lowCrate, poolLimited });
  if (lowCrate.length) console.log(`Thin crate (run npm run bench:recs -- --warm first): ${lowCrate.join(', ')}`);
  if (poolLimited.length) console.log(`Pool-limited (fewer than ${TOP_N} compliant candidates existed; not an engine verdict): ${poolLimited.join(', ')}`);
  if (LIMIT !== undefined && !status.startsWith('PARTIAL')) status = status === 'PASS' ? 'SMOKE' : 'SMOKE (FAIL)';
  console.log(`\nSTATUS: ${status}  criterion 3 holds on ${sum.passed}/${sum.n}; mean lane-hit ${fmt(sum.meanLaneHitRate)}`);
  console.log(`Requests: ${[...gates].map(([k, g]) => `${k} ${g.count}/${BUDGET[k]}`).join('  ')}`);
  if (stopped.length) console.log(`Stopped: ${[...guard.stopped].map(([k, v]) => `${k} (${v})`).join('; ')}`);
  if (cooldowns.length) console.log(`Breaker cooling down (start or during run): ${cooldowns.join(', ')}`);

  const out = join(here, 'results', `${runId}.json`);
  mkdirSync(dirname(out), { recursive: true });
  const base = { day, runId, status, stopped: Object.fromEntries(guard.stopped), refused: guard.refused, summary: sum, poolLimited, rows };
  if (!writesRating(LIMIT)) {
    // smoke run: no rating file and no key, so it can neither overwrite nor reveal a full run's
    writeFileSync(out, JSON.stringify(base, null, 2));
    console.log(`\nWrote ${out} (smoke run: no rating file)`);
    return;
  }
  // Lane membership for the baseline: the scenario lane's pool, or cached styles containing it (added in the crate rows).
  const poolKeys = Object.fromEntries(Object.entries(POOLS).map(([lane, list]) => [lane, new Set(list.map((t) => trackKeyOf(t.artist, t.title)))]));
  // One spelling source for BOTH lists: the cache's display name, else the pool entry; never a key-derived title-case.
  const poolName = new Map(Object.values(POOLS).flat().map((t) => [trackKeyOf(t.artist, t.title), t] as const));
  const display = (r: { artist: string; title: string }) => {
    const k = trackKeyOf(r.artist, r.title);
    const f = getEntry(k)?.fields;
    return f?.artist?.trim() && f?.title?.trim() ? { artist: f.artist, title: f.title } : poolName.get(k);
  };
  // The key (which list is the engine) lives here only; the rating file the owner sees has List A / List B.
  const rating = buildRatingFile(results, { fileId: runId, lanePool: (lane) => poolKeys[lane] ?? new Set(), display });
  for (const sh of rating.short) console.log(`baselineShort: ${sh.id}: engine ${sh.engine}, baseline ${sh.baseline} -> both lists trimmed to ${sh.used}`);
  writeFileSync(out, JSON.stringify({ ...base, baselineShort: rating.short, ratingFileId: rating.file.fileId, ratingKey: rating.key }, null, 2));
  const ratingOut = join(here, 'results', `${runId}-rating.json`);
  writeFileSync(ratingOut, JSON.stringify(rating.file, null, 2));
  console.log(`\nWrote ${out}\nWrote ${ratingOut} (blind: hand this to the owner, open /rate in dev; score the export with npm run bench:recs:ratings -- <export.json> ${out})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
