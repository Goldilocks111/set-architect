import { clampPlayFraction } from '@/lib/arc';
import { DEFAULT_PLAY_FRACTION, durationOf } from '@/lib/duration';
import type { Arc, ArcShape, Track } from '@/types/track';

// Rulebook §3, one target per quarter-hour slot of the 60 min template (T1–T15): the 'build' shape.
const SIXTY_MIN = [4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 8, 8, 9, 7, 6];

// Rulebook §3, 120 min template as [minute, energy] control points, linearly interpolated: the 'journey' shape.
const ONE_TWENTY_MIN: Array<[number, number]> = [
  [0, 3],
  [20, 5],
  [45, 6],
  [70, 8],
  [78, 9],
  [85, 9],
  [88, 6.5], // deliberate reset after first peak
  [95, 6.5],
  [105, 10], // main peak at ~80-90%
  [108, 10],
  [110, 7],
  [120, 5],
];

// [fraction of the set, energy] control points.
const SHAPE_POINTS: Record<Exclude<ArcShape, 'build'>, Array<[number, number]>> = {
  journey: ONE_TWENTY_MIN.map(([m, e]) => [m / 120, e]),
  // Opening slot: a gentle 3 -> 6, never more than one level per tenth of the set.
  'warm-up': [
    [0, 3],
    [0.35, 4],
    [0.75, 5],
    [1, 6],
  ],
  // Peak-time slot: starts at 7, one -2 reset (9 -> 7, rulebook §3) mid-set, main peak 10 from ~85% to the hand-over.
  'peak-time': [
    [0, 7],
    [0.3, 8.5],
    [0.5, 9],
    [0.55, 7],
    [0.62, 7],
    [0.85, 10],
    [1, 10],
  ],
};

function interpolate(points: Array<[number, number]>, x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x0, y0] = points[i - 1];
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

/** Target energy (whole MIK level) at `minute` into the set; the shape is stretched over arc.minutes and clamped outside. */
export function energyTargetAtMinute(arc: Arc, minute: number): number {
  const m = Number.isFinite(minute) ? minute : 0;
  const frac = Math.min(1, Math.max(0, m / Math.max(1, arc.minutes)));
  if (arc.shape === 'build') {
    return SIXTY_MIN[Math.min(SIXTY_MIN.length - 1, Math.floor(frac * SIXTY_MIN.length))];
  }
  // journey keeps the rulebook's own minute scale so 120-minute sets reproduce it exactly
  if (arc.shape === 'journey') return Math.round(interpolate(ONE_TWENTY_MIN, frac * 120));
  return Math.round(interpolate(SHAPE_POINTS[arc.shape] ?? SHAPE_POINTS['warm-up'], frac));
}

const FALLBACK_DURATION_MS = 300_000;

/** The track's real length, else its estimate (extended 6:30, radio/edit 3:30, otherwise 5:00). */
export const defaultDurationMs = (t: Track): number => durationOf(t).ms;

/** Minutes of `t` actually played; a duration source answering zero or non-finite counts as 5:00, never NaN. */
function playedMinutes(t: Track, playFraction: number, durationMsOf: (t: Track) => number): number {
  const ms = durationMsOf(t);
  const safe = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : FALLBACK_DURATION_MS;
  return (safe * clampPlayFraction(playFraction)) / 60_000;
}

/** Cumulative played minutes at each track's start (duration x play fraction). */
export function startMinutes(
  tracks: Track[],
  playFraction = DEFAULT_PLAY_FRACTION,
  durationMsOf: (t: Track) => number = defaultDurationMs
): number[] {
  const out: number[] = [];
  let at = 0;
  for (const t of tracks) {
    out.push(at);
    at += playedMinutes(t, playFraction, durationMsOf);
  }
  return out;
}

/** Played minutes of the whole set. */
export function setPlayedMinutes(
  tracks: Track[],
  playFraction = DEFAULT_PLAY_FRACTION,
  durationMsOf: (t: Track) => number = defaultDurationMs
): number {
  return tracks.reduce((sum, t) => sum + playedMinutes(t, playFraction, durationMsOf), 0);
}

/** The set's average played track length; 5:00 x fraction for an empty set. */
export function averagePlayedMinutes(
  tracks: Track[],
  playFraction = DEFAULT_PLAY_FRACTION,
  durationMsOf: (t: Track) => number = defaultDurationMs
): number {
  return tracks.length
    ? setPlayedMinutes(tracks, playFraction, durationMsOf) / tracks.length
    : (FALLBACK_DURATION_MS * clampPlayFraction(playFraction)) / 60_000;
}

/** About how many tracks fill the arc at a nominal 5:00 per track, for "N of ~M tracks". */
export function plannedTrackCount(arc: Arc, playFraction = DEFAULT_PLAY_FRACTION): number {
  return Math.max(1, Math.round(arc.minutes / (5.0 * clampPlayFraction(playFraction))));
}

/**
 * The minute at the middle of each track's played time, then of `extra` further slots as long as the set's
 * average played track (5:00 x fraction when empty). A track's target is read at its middle: with 4:00 played
 * per track this reproduces the rulebook's per-position 60/120 min templates exactly.
 */
export function slotMidMinutes(
  tracks: Track[],
  extra = 0,
  playFraction = DEFAULT_PLAY_FRACTION,
  durationMsOf: (t: Track) => number = defaultDurationMs
): number[] {
  const out: number[] = [];
  let at = 0;
  for (const t of tracks) {
    const len = playedMinutes(t, playFraction, durationMsOf);
    out.push(at + len / 2);
    at += len;
  }
  const slot = averagePlayedMinutes(tracks, playFraction, durationMsOf);
  for (let i = 0; i < extra; i++) out.push(at + slot * (i + 0.5));
  return out;
}

/** Arc target for each track of the set. */
export function trackTargets(
  arc: Arc,
  tracks: Track[],
  playFraction = DEFAULT_PLAY_FRACTION,
  durationMsOf: (t: Track) => number = defaultDurationMs
): number[] {
  return slotMidMinutes(tracks, 0, playFraction, durationMsOf).map((m) => energyTargetAtMinute(arc, m));
}

/** Arc target for the track that would be added next (it starts where the set's played minutes end). */
export function nextTrackTarget(
  arc: Arc,
  tracks: Track[],
  playFraction = DEFAULT_PLAY_FRACTION,
  durationMsOf: (t: Track) => number = defaultDurationMs
): number {
  return energyTargetAtMinute(arc, slotMidMinutes(tracks, 1, playFraction, durationMsOf)[tracks.length]);
}

const distScore = (dist: number) => (dist <= 1 ? 1 : Math.max(0.3, 1 - 0.25 * (dist - 1)));

// Rulebook §3: one level at a time toward the arc target; +2 is a "Big energy jump" (the
// key-boost exception is applied in suggest.ts); a drop of 2-3 landing near target is a tolerated reset.
export function scoreEnergyTransition(
  fromE: number | undefined,
  toE: number | undefined,
  target: number
): { score: number; label: string } {
  if (toE === undefined) return { score: 0.5, label: 'Energy unknown' };
  const dist = Math.abs(toE - target);
  if (fromE === undefined) {
    return { score: distScore(dist), label: dist <= 1 ? 'Fits arc' : 'Off arc' };
  }
  const delta = toE - fromE;
  if (delta === 2) return { score: 0.4, label: 'Big energy jump' };
  if (delta >= 3) return { score: 0.1, label: 'Big energy jump' };
  if (delta <= -2) {
    // Rulebook §3: only a -2..-3 reset is allowed; anything bigger is an accidental crash.
    if (delta >= -3) {
      return dist <= 1
        ? { score: 0.7, label: 'Energy reset' }
        : { score: delta === -2 ? 0.3 : 0.2, label: 'Energy drop' };
    }
    return { score: 0.1, label: 'Energy crash' };
  }
  const away = dist > Math.abs(fromE - target);
  const score = Math.max(0.1, distScore(dist) - (away && dist > 1 ? 0.15 : 0));
  const label = delta === 0 ? 'Holds energy' : `Energy ${delta > 0 ? '+' : '-'}1`;
  return { score, label };
}
