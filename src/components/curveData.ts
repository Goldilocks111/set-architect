import { energyTargetAtMinute, setPlayedMinutes, startMinutes } from '@/engine';
import { DEFAULT_PLAY_FRACTION } from '@/lib/arc';
import { isComplete } from '@/lib/completeness';
import { durationOf, formatMinutes } from '@/lib/duration';
import type { Arc, Track } from '@/types/track';

export interface TrackTime {
  startMin: number; // cumulative played minutes before this track
  durationMs: number; // the track's full length (real or estimated)
  estimated: boolean;
}

export interface SetTiming {
  tracks: TrackTime[];
  playedMin: number;
  plannedMin: number;
  /** Any track's length is an estimate, so the played total is too. */
  estimated: boolean;
  /** Played minutes beyond the planned length (0 when within). */
  overrunMin: number;
}

/** The one source of cumulative time for the set rows, the header and the curve (engine startMinutes). */
export function setTiming(tracks: Track[], arc: Arc, playFraction = DEFAULT_PLAY_FRACTION): SetTiming {
  const starts = startMinutes(tracks, playFraction);
  const rows = tracks.map((t, i) => {
    const d = durationOf(t);
    return { startMin: starts[i], durationMs: d.ms, estimated: d.estimated };
  });
  const playedMin = setPlayedMinutes(tracks, playFraction);
  return {
    tracks: rows,
    playedMin,
    plannedMin: arc.minutes,
    estimated: rows.some((r) => r.estimated),
    overrunMin: Math.max(0, playedMin - arc.minutes),
  };
}

const fmtMin = (min: number) => formatMinutes(min * 60_000);

/** "38:20 of 1:00:00 · 9 of ~16 tracks"; the played time reads "~38:20" when any length is estimated. */
export function timingHeaderText(t: SetTiming, count: number, plannedCount: number): string {
  return `${t.estimated ? '~' : ''}${fmtMin(t.playedMin)} of ${fmtMin(t.plannedMin)} · ${count} of ~${plannedCount} tracks`;
}

/** "+4:10 over" when the set plays past the planned length (to the second), else null. */
export function overrunText(t: SetTiming): string | null {
  return Math.round(t.overrunMin * 60) > 0 ? `+${fmtMin(t.overrunMin)} over` : null;
}

export interface CurvePoint {
  minute: number;
  /** Arc target at this minute; null beyond the planned length. */
  target: number | null;
  /** Energy of the track playing at this minute; null = unknown energy or no track (a gap, never 0). */
  energy: number | null;
  bpm: number | null;
  position: number | null; // 1-based track playing here
  label: string | null;
  overrun: boolean; // past the planned length
}

export interface CurveData {
  points: CurvePoint[];
  plannedMin: number;
  /** X-axis end: max(planned, played). */
  maxMin: number;
  overrun: { from: number; to: number } | null;
}

const finiteOrNull = (v: number | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const EPS = 1e-9;
/** Bound on whole-minute samples: arcs are <= 480', but a runaway set of bogus lengths must not draw forever. */
const MAX_SAMPLE_MINUTE = 2_000;

/**
 * Curve by minute: the target sampled every whole minute of the planned length, the set's energy as a step
 * (a point at each track's start and at its end, so the line steps at the start minutes), and every point past
 * the planned length flagged as overrun.
 */
export function buildCurveData(tracks: Track[], arc: Arc, playFraction = DEFAULT_PLAY_FRACTION): CurveData {
  const timing = setTiming(tracks, arc, playFraction);
  const plannedMin = arc.minutes;
  const maxMin = Math.max(plannedMin, timing.playedMin);
  const starts = timing.tracks.map((r) => r.startMin);
  const ends = tracks.map((_, i) => (i + 1 < tracks.length ? starts[i + 1] : timing.playedMin));

  const point = (minute: number, i: number | null): CurvePoint => {
    const t = i === null ? undefined : tracks[i];
    const overrun = minute > plannedMin + EPS;
    return {
      minute,
      target: overrun ? null : energyTargetAtMinute(arc, minute),
      energy: finiteOrNull(t?.energy),
      bpm: finiteOrNull(t?.bpm),
      position: i === null ? null : i + 1,
      label: t ? `${t.artist} – ${t.title}` : null,
      overrun,
    };
  };

  // within one minute: a track's end, then the next track's start, then a plain sample
  const events: Array<{ minute: number; rank: number; i: number | null }> = [];
  tracks.forEach((_, i) => {
    events.push({ minute: starts[i], rank: 1, i });
    events.push({ minute: ends[i], rank: 0, i });
  });
  const boundaries = [...starts, ...ends];
  const onBoundary = (m: number) => boundaries.some((b) => Math.abs(b - m) < EPS);

  const last = Math.floor(Math.min(maxMin, MAX_SAMPLE_MINUTE) + EPS);
  const samples = Array.from({ length: last + 1 }, (_, m) => m);
  if (!samples.includes(plannedMin)) samples.push(plannedMin);
  samples.sort((a, b) => a - b);
  let cover = 0;
  for (const m of samples) {
    if (onBoundary(m)) continue;
    while (cover < tracks.length && ends[cover] <= m + EPS) cover++;
    const playing = cover < tracks.length && starts[cover] <= m + EPS ? cover : null;
    events.push({ minute: m, rank: 2, i: playing });
  }
  events.sort((a, b) => a.minute - b.minute || a.rank - b.rank || (a.i ?? 0) - (b.i ?? 0));

  return {
    points: events.map((e) => point(e.minute, e.i)),
    plannedMin,
    maxMin,
    overrun: maxMin > plannedMin + EPS ? { from: plannedMin, to: maxMin } : null,
  };
}

/** Incomplete tracks are quarantined: their energy is not drawn on the curve (the slot stays, as a gap). */
export const quarantineForCurve = (tracks: Track[]): Track[] =>
  tracks.map((t) => (isComplete(t) ? t : { ...t, energy: undefined }));
