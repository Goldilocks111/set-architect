import type { Track } from '@/types/track';

// Pure: imported by both client and server. Do not import node modules here.
export const ESSENTIALS = ['bpm', 'camelot', 'energy', 'danceability'] as const;
export type Essential = (typeof ESSENTIALS)[number];
export type IncompleteReason = 'not-found' | 'no-preview' | 'analysis-failed' | 'providers-unavailable' | 'timeout';

/** Reasons worth retrying later; the others are properties of the track itself. */
export const RETRYABLE_REASONS: readonly IncompleteReason[] = ['providers-unavailable', 'timeout'];

const present = (t: Track, f: Essential): boolean => {
  const v = t[f];
  return f === 'camelot' ? typeof v === 'string' && v.length > 0 : typeof v === 'number' && Number.isFinite(v);
};

/** Danceability 0 counts as present: only undefined / non-finite is missing. */
export function missingEssentials(t: Track): Essential[] {
  return ESSENTIALS.filter((f) => !present(t, f));
}

export function isComplete(t: Track): boolean {
  return missingEssentials(t).length === 0;
}
