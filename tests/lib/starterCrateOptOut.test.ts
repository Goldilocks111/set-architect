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
  const { suggestions } = await assembleSuggestions({ playlist: [last], template: '60min', plannedLength: 12, crate }, deps);
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
