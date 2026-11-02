import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir, dataRoot } from '../../src/lib/dataDir';
import { activeCooldowns, degradedProviders, readCooldowns } from '../data/cooldowns';
import { createFetchGuard } from '../data/guardFetch';
import { RequestGate, dayKey, loadDailyCounts, saveDailyCounts } from '../search/guard';
import { buildRatingFile, criterion3Holds, recsStatus, scoreScenario, summarizeRecs, validateScenarios, type Scenario } from './score';
import type { Suggestion, Track } from '../../src/types/track';

try {
  (process as any).loadEnvFile?.('.env');
} catch {
  // no .env: unconfigured providers are skipped by the resolver
}

const here = __dirname;
const limitArg = process.argv.slice(2).find((a) => a.startsWith('--limit='));
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
  const { assembleSuggestions, loadSuggestDeps } = await import('../../src/app/api/suggest/assemble');
  const deps = await loadSuggestDeps();

  const toCrate = (r: { artist: string; title: string }, i: number): Track => ({ id: `crate-${i}`, artist: r.artist, title: r.title, sources: {} });
  const results: Array<{ scenario: Scenario; suggestions: Suggestion[] }> = [];
  const rows: Array<Record<string, unknown>> = [];
  for (const [i, sc] of subset.entries()) {
    const t0 = Date.now();
    const playlist: Track[] = [];
    for (const ref of sc.set) playlist.push(await resolveWithStatus(ref.artist, ref.title));
    const incomplete = playlist.filter((t) => t.unresolved).length;
    const { suggestions } = await assembleSuggestions(
      { playlist, template: sc.template, plannedLength: sc.plannedLength, crate: (sc.crate ?? []).map(toCrate) },
      deps,
    );
    const score = scoreScenario(sc, suggestions);
    results.push({ scenario: sc, suggestions });
    rows.push({
      id: sc.id, lane: sc.lane, setSize: sc.set.length, incompleteInSet: incomplete, ...score, pass: criterion3Holds(score),
      top10: suggestions.slice(0, 10).map((s) => ({ artist: s.track.artist, title: s.track.title, score: s.score, compliant: s.compliant, reasons: s.reasons.map((r) => r.label) })),
      ms: Date.now() - t0,
    });
    console.log(`[${i + 1}/${subset.length}] ${sc.id}: ${score.compliant}/${score.n} compliant, reasons ${score.reasonsOnAll ? 'all' : 'MISSING'}, lane ${fmt(score.laneHitRate)}  ${criterion3Holds(score) ? 'ok' : 'FAIL'}`);
  }

  const sum = summarizeRecs(rows as any);
  const stopped = [...guard.stopped.keys()];
  const refused = Object.keys(guard.refused);
  const cooldowns = degradedProviders(cooldownSeed, readCooldowns(realRoot));
  let status = recsStatus({ passed: sum.passed, n: sum.n, stopped, refused, cooldowns });
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
