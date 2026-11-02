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

/** Source label for a danceability filled from energy because no provider or analysis supplied one. */
export const DANCEABILITY_PRIOR_SOURCE = 'estimate-prior';

/**
 * Owner ruling (final review I3): local danceability is no better than a constant, so a track whose danceability is
 * still missing after resolution, but whose energy is known, gets clamp(0.45 + 0.05 × energy, 0, 1) to 2 dp.
 */
export function danceabilityPrior(energy: number): number {
  return Math.round(Math.min(1, Math.max(0, 0.45 + 0.05 * energy)) * 100) / 100;
}

/** Fills a missing danceability from energy (never replaces a value); returns `t` itself when nothing changes. */
export function withDanceabilityPrior(t: Track): Track {
  if (present(t, 'danceability') || !present(t, 'energy')) return t;
  return { ...t, danceability: danceabilityPrior(t.energy!), sources: { ...t.sources, danceability: DANCEABILITY_PRIOR_SOURCE } };
}
