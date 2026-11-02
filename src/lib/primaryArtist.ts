import { trackKeyOf } from '@/types/track';

/**
 * First credited artist, normalized the way track keys are ("A feat. B", "A & B", "A x B" -> a). Separators are whole
 * words (Featurecast, Ftampa, Vsevolod, X-Press 2 stay intact); when splitting leaves an empty first credit
 * ("&ME", "Ft. Lauderdale") the whole normalized artist string is used.
 */
export function primaryArtist(artist: string): string {
  const first = artist.split(/\s*(?:,|;|\/|&|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|\bvs\b\.?|\bx\b(?![-\w]))\s*/i)[0] ?? artist;
  const key = trackKeyOf(first, '').split('|')[0];
  return key || trackKeyOf(artist, '').split('|')[0];
}
