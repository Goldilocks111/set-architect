import { isSameTrackQualifier, trackKeyOf } from '@/types/track';

/**
 * Version of trackKeyOf's normalization. Runtime stores keyed by trackKey record the version they were
 * written with and re-key themselves on load when it is older.
 * 1: V1 (strips "(… Original Mix | Extended Mix | Radio Edit …)").
 * 2: also strips every same-recording qualifier: "(Extended)", "(Club Mix)", "[2014 Remaster]", "- Edit", ….
 */
export const TRACK_KEY_VERSION = 2;

/**
 * The current key for a key written by an older version when the original artist/title are not stored.
 * The old normalization turned "Cola (Club Mix)" into "cola club mix", so a trailing run of qualifier words
 * is read as the suffix trackKeyOf now strips. A title is never reduced to nothing ("Original" stays).
 */
export function rekeyLegacy(oldKey: string): string {
  const sep = oldKey.indexOf('|');
  if (sep < 0) return oldKey;
  const artist = oldKey.slice(0, sep);
  const words = oldKey.slice(sep + 1).split(' ').filter(Boolean);
  let cut = words.length;
  while (cut > 1 && isSameTrackQualifier(words[cut - 1])) cut--;
  if (cut === words.length) return oldKey;
  return trackKeyOf(artist, `${words.slice(0, cut).join(' ')} - ${words.slice(cut).join(' ')}`);
}

/** Re-keys a trackKey-keyed record, combining values whose keys now coincide. */
export function rekeyRecord<T>(rec: Record<string, T>, combine: (a: T, b: T) => T, rekey: (k: string) => string = rekeyLegacy): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) {
    const nk = rekey(k);
    out[nk] = nk in out ? combine(out[nk], v) : v;
  }
  return out;
}
