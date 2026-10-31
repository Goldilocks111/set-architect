// Frozen contract — demo-mode data access. Change only via integrator.
import seed from '../../data/seed/tracks.demo.json';
import type { Track } from '@/types/track';

type SeedTrack = Omit<Track, 'sources'> & { sources?: Record<string, string> };

export function demoTracks(): Track[] {
  return (seed as SeedTrack[]).map((t) => ({
    ...t,
    sources: Object.fromEntries(
      (['bpm', 'camelot', 'energy'] as const).filter((f) => t[f] !== undefined).map((f) => [f, 'demo-seed'])
    ),
  }));
}

export function searchDemoTracks(query: string): Track[] {
  const q = query.toLowerCase();
  return demoTracks().filter(
    (t) => t.artist.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)
  );
}

/** True when no Supabase env is configured — the whole app must work in this mode. */
export function isDemoMode(): boolean {
  return !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}
