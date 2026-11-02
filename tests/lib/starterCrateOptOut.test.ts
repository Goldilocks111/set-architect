// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assembleSuggestions, DEMO_CRATE_MIN, type SuggestDeps } from '@/app/api/suggest/assemble';
import { demoTracks } from '@/lib/demo';
import { suggestNext as engineSuggestNext } from '@/engine';
import type { Track } from '@/types/track';

// complete tracks that are not demo tracks: the demo seed's essentials under new names and non-demo sources
const own = (n: number): Track[] =>
  demoTracks().slice(0, n).map((t, i) => ({
    ...t,
    id: `own-${i}`,
    artist: `Own Artist ${i}`,
    title: `Own Title ${i}`,
    sources: { bpm: 'deezer', camelot: 'getsongbpm', energy: 'reccobeats' },
  }));
const isDemo = (t: Track) => Object.values(t.sources ?? {}).includes('demo-seed') || demoTracks().some((d) => d.id === t.id);

async function run(extra: Partial<SuggestDeps>) {
  const [last, ...crate] = own(6);
  let candidates: Track[] = [];
  const deps: SuggestDeps = {
    ...extra,
    suggestNext: (o) => {
      candidates = o.candidates;
      return engineSuggestNext(o);
    },
  };
  const { suggestions } = await assembleSuggestions({ playlist: [last], arc: { minutes: 60, shape: 'build' }, crate }, deps);
  return { candidates, suggestions };
}

describe('starter (demo) crate opt-out', () => {
  it('the app path still pads a crate under DEMO_CRATE_MIN ready tracks with the demo crate', async () => {
    expect(DEMO_CRATE_MIN).toBe(30);
    const { candidates } = await run({});
    expect(candidates.some(isDemo)).toBe(true);
  });
  it('noStarterCrate: the pool is the crate only, and no suggestion is a demo-seed track', async () => {
    const { candidates, suggestions } = await run({ noStarterCrate: true });
    expect(candidates.map((t) => t.id).sort()).toEqual(['own-1', 'own-2', 'own-3', 'own-4', 'own-5']);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.filter((s) => isDemo(s.track))).toEqual([]);
  });
});

describe('compliantAvailable (I4: is the pool, not the engine, the limit?)', () => {
  it('asks the engine for every candidate and counts the compliant ones; still returns the top 10', async () => {
    const all = own(15).map((track, i) => ({ track, score: 1 - i / 100, reasons: [{ kind: 'key' as const, label: 'k', score: 1 }], compliant: i < 12 }));
    let limit: number | undefined;
    const res = await assembleSuggestions(
      { playlist: [], arc: { minutes: 60, shape: 'build' }, crate: own(15) },
      { noStarterCrate: true, suggestNext: (o) => ((limit = o.limit), all.slice(0, o.limit ?? 10)) },
    );
    expect(limit).toBe(Infinity);
    expect(res.compliantAvailable).toBe(12);
    expect(res.suggestions).toHaveLength(10);
  });
  it('matches the real engine on a real pool', async () => {
    const [last, ...crate] = own(30);
    const res = await assembleSuggestions({ playlist: [last], arc: { minutes: 60, shape: 'build' }, crate }, { noStarterCrate: true });
    const full = engineSuggestNext({ playlist: [last], candidates: crate, arc: { minutes: 60, shape: 'build' }, adjacency: new Map(), similarity: new Map(), limit: Infinity });
    expect(res.compliantAvailable).toBe(full.filter((s) => s.compliant === true).length);
  });
});
