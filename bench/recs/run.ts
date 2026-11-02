import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir, dataRoot } from '../../src/lib/dataDir';
import { activeCooldowns, degradedProviders, readCooldowns } from '../data/cooldowns';
import { createFetchGuard } from '../data/guardFetch';
import { RequestGate, dayKey, loadDailyCounts, saveDailyCounts } from '../search/guard';
import { buildRatingFile, criterion3Holds, lowCrateScenarios, recsStatus, scoreScenario, selectWarmTargets, summarizeRecs, uniqueScenarioTracks, validateScenarios, type Scenario, type ScenarioScore } from './score';
import type { Suggestion, Track } from '../../src/types/track';

try {
  (process as any).loadEnvFile?.('.env');
} catch {
  // no .env: unconfigured providers are skipped by the resolver
}

const here = __dirname;
const limitArg = process.argv.slice(2).find((a) => a.startsWith('--limit='));
const WARM = process.argv.slice(2).includes('--warm');
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : undefined;

/** Hard per-provider request budgets (daily counts shared with the other benches). */
const BUDGET: Record<string, number> = { spotify: 60, deezer: 300, lastfm: 400, musicbrainz: 200, reccobeats: 200 };
/** Minimum gap between requests per provider (ms). MusicBrainz is 1 req/s. */
const GAP_MS: Record<string, number> = { spotify: 340, deezer: 340, lastfm: 250, musicbrainz: 1100, reccobeats: 340 };
const gates = new Map<string, RequestGate>();
const fmt = (x: number) => `${(x * 100).toFixed(0)}%`;

async function main(): Promise<void> {
  const scenarios: Scenario[] = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'));
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
  const { resolveWithStatus } = await import('../../src/lib/resolver');
  if (WARM) {
    const { getEntry } = await import('../../src/lib/metadataCache');
    const { isComplete } = await import('../../src/lib/completeness');
    const { trackKeyOf } = await import('../../src/types/track');
    const refs = uniqueScenarioTracks(subset);
    console.log(`warm: ${refs.length} unique tracks across ${subset.length} scenarios`);
    const { todo } = selectWarmTargets(refs, (r) => {
      const e = getEntry(trackKeyOf(r.artist, r.title));
      return !!e && isComplete({ id: 'w', artist: r.artist, title: r.title, sources: {}, ...e.fields } as Track);
    });
    console.log(`warm: ${refs.length - todo.length}/${refs.length} complete, resolving ${todo.length}`);
    for (const [i, r] of todo.entries()) {
      if (guard.stopped.size || Object.keys(guard.refused).length) break; // a stopped or exhausted provider ends the run
      const t = await resolveWithStatus(r.artist, r.title, { without: ['itunes'], retryWithout: ['itunes'] });
      if (i % 10 === 9) console.log(`  ${i + 1}/${todo.length}${t.unresolved ? ' (last: incomplete)' : ''}`);
    }
    const left = selectWarmTargets(refs, (r) => {
      const e = getEntry(trackKeyOf(r.artist, r.title));
      return !!e && isComplete({ id: 'w', artist: r.artist, title: r.title, sources: {}, ...e.fields } as Track);
    });
    const stoppedW = [...guard.stopped.keys()];
    const refusedW = Object.keys(guard.refused);
    const cdW = degradedProviders(cooldownSeed, readCooldowns(realRoot));
    const partial = stoppedW.length || refusedW.length || cdW.length;
    console.log(`warm: ${refs.length - left.todo.length}/${refs.length} complete${partial ? ` PARTIAL (stopped ${stoppedW.join(',') || '-'}; budget ${refusedW.join(',') || '-'}; cooldown ${cdW.join(',') || '-'})` : ''}`);
    console.log(`Requests: ${[...gates].map(([k, g]) => `${k} ${g.count}/${BUDGET[k]}`).join('  ')}`);
    return;
  }
  const { assembleSuggestions, loadSuggestDeps } = await import('../../src/app/api/suggest/assemble');
  const deps = await loadSuggestDeps();
  // Results must not depend on scenario order: no background crate fills, no scheduled retries; styles settle between scenarios.
  deps.backgroundResolve = undefined;
  const { setReresolveDeps } = await import('../../src/lib/reresolve');
  setReresolveDeps({ setTimer: () => undefined });
  const { settleStyles } = await import('../../src/lib/resolver');

  const toCrate = (r: { artist: string; title: string }, i: number): Track => ({ id: `crate-${i}`, artist: r.artist, title: r.title, sources: {} });
  const results: Array<{ scenario: Scenario; suggestions: Suggestion[] }> = [];
  const rows: Array<ScenarioScore & Record<string, unknown> & { id: string; crateReady: number }> = [];
  for (const [i, sc] of subset.entries()) {
    const t0 = Date.now();
    const playlist: Track[] = [];
    for (const ref of sc.set) playlist.push(await resolveWithStatus(ref.artist, ref.title));
    await settleStyles(); // the set's own styles lookups land before the engine reads the cache
    const incomplete = playlist.filter((t) => t.unresolved).length;
    const { suggestions, crateKnown } = await assembleSuggestions(
      { playlist, template: sc.template, plannedLength: sc.plannedLength, crate: (sc.crate ?? []).map(toCrate) },
      deps,
    );
    await settleStyles(); // candidate lookups started by this scenario finish before the next one starts
    const score = scoreScenario(sc, suggestions);
    results.push({ scenario: sc, suggestions });
    rows.push({
      id: sc.id, lane: sc.lane, setSize: sc.set.length, incompleteInSet: incomplete, crateReady: crateKnown.length, ...score, pass: criterion3Holds(score),
      top10: suggestions.slice(0, 10).map((s) => ({ artist: s.track.artist, title: s.track.title, score: s.score, compliant: s.compliant, reasons: s.reasons.map((r) => r.label) })),
      ms: Date.now() - t0,
    });
    console.log(`[${i + 1}/${subset.length}] ${sc.id}: ${score.compliant}/${score.n} compliant, reasons ${score.reasonsOnAll ? 'all' : 'MISSING'}, lane ${fmt(score.laneHitRate)}  ${criterion3Holds(score) ? 'ok' : 'FAIL'}  crateReady ${crateKnown.length}/${(sc.crate ?? []).length}`);
  }

  const sum = summarizeRecs(rows);
  const stopped = [...guard.stopped.keys()];
  const refused = Object.keys(guard.refused);
  const cooldowns = degradedProviders(cooldownSeed, readCooldowns(realRoot));
  const lowCrate = lowCrateScenarios(rows);
  let status = recsStatus({ passed: sum.passed, n: sum.n, stopped, refused, cooldowns, lowCrate });
  if (lowCrate.length) console.log(`Thin crate (run npm run bench:recs -- --warm first): ${lowCrate.join(', ')}`);
  if (LIMIT !== undefined && !status.startsWith('PARTIAL')) status = status === 'PASS' ? 'SMOKE' : 'SMOKE (FAIL)';
  console.log(`\nSTATUS: ${status}  criterion 3 holds on ${sum.passed}/${sum.n}; mean lane-hit ${fmt(sum.meanLaneHitRate)}`);
  console.log(`Requests: ${[...gates].map(([k, g]) => `${k} ${g.count}/${BUDGET[k]}`).join('  ')}`);
  if (stopped.length) console.log(`Stopped: ${[...guard.stopped].map(([k, v]) => `${k} (${v})`).join('; ')}`);
  if (cooldowns.length) console.log(`Breaker cooling down (start or during run): ${cooldowns.join(', ')}`);

  const out = join(here, 'results', `${day}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ day, status, stopped: Object.fromEntries(guard.stopped), refused: guard.refused, summary: sum, rows }, null, 2));
  const ratingOut = join(here, 'results', `${day}-rating.json`);
  writeFileSync(ratingOut, JSON.stringify(buildRatingFile(results), null, 2));
  console.log(`\nWrote ${out}\nWrote ${ratingOut} (blind: hand this to the owner, open /rate in dev)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
