import { averagePlayedMinutes, energyTargetAtMinute, setPlayedMinutes, slotMidMinutes, trackTargets } from '@/engine';
import { DEFAULT_PLAY_FRACTION } from '@/lib/arc';
import { isComplete } from '@/lib/completeness';
import type { Arc, Track } from '@/types/track';

export interface CurveRow {
  position: number; // 1-based slot in the set
  label: string | null;
  energy: number | null; // null renders as a gap
  target: number;
  bpm: number | null;
}

const finiteOrNull = (v: number | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** A set of bogus 1-ms durations must not draw thousands of empty slots (480' at 50% of 5:00 is 192). */
const MAX_OPEN_SLOTS = 200;

/** One row per set track, then open slots (the set's average played length) until the arc's minutes are filled. */
export function buildCurveData(tracks: Track[], arc: Arc, playFraction = DEFAULT_PLAY_FRACTION): CurveRow[] {
  const played = setPlayedMinutes(tracks, playFraction);
  const left = Math.ceil((arc.minutes - played) / averagePlayedMinutes(tracks, playFraction) - 1e-9);
  const open = Math.min(MAX_OPEN_SLOTS, Math.max(0, left));
  const mids = slotMidMinutes(tracks, open, playFraction);
  // set rows show the target the engine suggested them against (same as the transition badges)
  const setTargets = trackTargets(arc, tracks, playFraction);
  return mids.map((minute, i) => {
    const track = tracks[i];
    return {
      position: i + 1,
      label: track ? `${track.artist} – ${track.title}` : null,
      energy: finiteOrNull(track?.energy),
      target: i < tracks.length ? setTargets[i] : energyTargetAtMinute(arc, minute),
      bpm: finiteOrNull(track?.bpm),
    };
  });
}

/** Incomplete tracks are quarantined: their energy is not drawn on the curve (the slot stays, as a gap). */
export const quarantineForCurve = (tracks: Track[]): Track[] =>
  tracks.map((t) => (isComplete(t) ? t : { ...t, energy: undefined }));
