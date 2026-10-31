import { energyTargetAt } from '@/engine';
import type { ArcTemplate, Track } from '@/types/track';

export interface CurveRow {
  position: number; // 1-based slot in the set
  label: string | null;
  energy: number | null; // null renders as a gap
  target: number;
  bpm: number | null;
}

const finiteOrNull = (v: number | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function buildCurveData(tracks: Track[], template: ArcTemplate, plannedLength: number): CurveRow[] {
  const length = Math.max(plannedLength, tracks.length);
  return Array.from({ length }, (_, i) => {
    const track = tracks[i];
    return {
      position: i + 1,
      label: track ? `${track.artist} – ${track.title}` : null,
      energy: finiteOrNull(track?.energy),
      target: energyTargetAt(template, i, plannedLength),
      bpm: finiteOrNull(track?.bpm),
    };
  });
}
