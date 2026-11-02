import type { Track } from '@/types/track';

/** How much of each track is actually played in a mix (the rest is the overlap with its neighbours). */
export const DEFAULT_PLAY_FRACTION = 0.75;

const EXTENDED = /\b(extended|club mix|club version|original mix)\b/i;
const SHORT = /\b(radio|edit)\b/i;
const MIN = 60_000;

/** Guess when a provider gave no length: extended/club/original mix 6:30, radio/edit 3:30, anything else 5:00. */
export function estimatedDurationMs(t: Pick<Track, 'version' | 'title'>): number {
  const label = t.version ?? t.title;
  if (EXTENDED.test(label)) return 6.5 * MIN;
  if (SHORT.test(label)) return 3.5 * MIN;
  return 5 * MIN;
}

/** The real length when known, else a clearly flagged estimate. Never NaN. */
export function durationOf(t: Track): { ms: number; estimated: boolean } {
  const d = t.durationMs;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) return { ms: d, estimated: false };
  return { ms: estimatedDurationMs(t), estimated: true };
}

/** "m:ss", or "h:mm:ss" from one hour up. */
export function formatMinutes(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
