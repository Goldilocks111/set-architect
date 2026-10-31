import { isSameTrackQualifier } from '@/types/track';

/**
 * Version of trackKeyOf's normalization. Runtime stores keyed by trackKey record the version they were
 * written with and re-key themselves on load when it is older.
 * 1: V1 (strips "(… Original Mix | Extended Mix | Radio Edit …)").
 * 2: also strips every same-recording qualifier: "(Extended)", "(Club Mix)", "[2014 Remaster]", "- Edit", ….
 */
export const TRACK_KEY_VERSION = 2;

/**
 * True when a key written by an older version may name a title the current normalization keys differently:
 * its title ends in a qualifier word ("cola club mix" was "Cola (Club Mix)"). Without the original title this
 * cannot be told apart from a real title ("in da club"), so such entries are dropped, not guessed.
 */
export function mayBeStaleKey(key: string): boolean {
  const words = key.slice(key.indexOf('|') + 1).split(' ').filter(Boolean);
  return words.length > 1 && isSameTrackQualifier(words[words.length - 1]);
}

/** Keeps only the entries whose old key is certainly still current; the rest is cheap to rebuild. */
export function dropStaleKeys<T>(rec: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).filter(([k]) => !mayBeStaleKey(k)));
}
