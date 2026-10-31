import type { Track } from '@/types/track';
import { energyTo10, toCamelot } from './camelot';

export interface RawFeatures {
  tempo?: number;
  bpm?: number;
  key?: number;
  mode?: number;
  energy?: number;
  danceability?: number;
}

/** Spotify-style audio features → Track fields. */
export function mapFeatures(f: RawFeatures): Partial<Track> {
  const out: Partial<Track> = {};
  const bpm = f.tempo ?? f.bpm;
  if (typeof bpm === 'number' && bpm > 0) out.bpm = Math.round(bpm * 10) / 10;
  if (typeof f.key === 'number' && typeof f.mode === 'number') {
    const c = toCamelot(f.key, f.mode);
    if (c) out.camelot = c;
  }
  if (typeof f.energy === 'number') {
    const e = energyTo10(f.energy);
    if (e !== undefined) out.energy = e;
  }
  if (typeof f.danceability === 'number') out.danceability = f.danceability;
  return out;
}
