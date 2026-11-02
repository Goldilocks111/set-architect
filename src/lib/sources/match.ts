import { trackKeyOf } from '@/types/track';

/** "(feat. X)", "[ft. X]", "- feat. X": a guest credit, not a different recording. */
const stripGuest = (s: string) =>
  s.replace(/[([]\s*(?:feat|ft|featuring|with)\b[^)\]]*[)\]]/gi, '').replace(/\s+[-–—]?\s*(?:feat|ft|featuring)\.?\s.*$/i, '');

const titleKey = (t: string) => trackKeyOf('', stripGuest(t)).split('|')[1] ?? '';

/**
 * A search hit is the wanted song, not just another song by the same artist: the titles agree once same-recording
 * qualifiers ("Original Mix", "Radio Edit") and guest credits are dropped. Adapters take a hit only when this holds,
 * so a wrong song's preview, ISRC or Spotify id never reaches the cache (preview analysis and ReccoBeats read them).
 */
export const titleMatches = (wanted: string, got?: string): boolean => {
  const a = titleKey(wanted);
  return !!a && a === titleKey(got ?? '');
};
