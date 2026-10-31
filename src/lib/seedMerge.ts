import { demoTracks } from '@/lib/demo';
import { trackKeyOf, type Track } from '@/types/track';

const FIELDS = ['bpm', 'camelot', 'energy'] as const;

/** Fills missing bpm/camelot/energy from the demo seed entry for the same track, tagging them 'demo-seed'. */
export function mergeSeedMetadata(track: Track): Track {
  const key = trackKeyOf(track.artist, track.title);
  const seed = demoTracks().find((t) => trackKeyOf(t.artist, t.title) === key);
  if (!seed) return track;
  const merged: Track = { ...track, sources: { ...track.sources } };
  for (const f of FIELDS) {
    if (merged[f] === undefined && seed[f] !== undefined) {
      (merged as unknown as Record<string, unknown>)[f] = seed[f];
      merged.sources[f] = 'demo-seed';
    }
  }
  return merged;
}
