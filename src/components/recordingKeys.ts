import { trackKeyOf, type Track } from '@/types/track';

/**
 * Identities under which a track counts as "already in the set": its id, its ISRC, and its normalized
 * artist/title plus version label. Search ids can differ between searches (an ISRC-less hit, a provider
 * that was down), so the id alone would let the same recording be added twice.
 */
export function recordingKeys(t: Pick<Track, 'id' | 'artist' | 'title' | 'isrc' | 'version'>): string[] {
  const keys = [t.id, `rec:${trackKeyOf(t.artist, t.title)}|${(t.version ?? '').toLowerCase()}`];
  if (t.isrc) keys.push(`isrc:${t.isrc.toUpperCase()}`);
  return keys;
}

export const isInSet = (set: Set<string>, t: Parameters<typeof recordingKeys>[0]) => recordingKeys(t).some((k) => set.has(k));
