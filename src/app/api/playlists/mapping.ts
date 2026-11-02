import type { TrackRow } from '@/lib/supabase/types';
import type { Arc, Track } from '@/types/track';

export interface SavedPlaylist {
  id: string;
  name: string;
  arc: Arc;
  createdAt: string;
  tracks: Track[];
}

const num = (v: number | string | null) => (v === null || v === '' ? undefined : Number(v));

export function rowToTrack(r: TrackRow): Track {
  return {
    id: r.id,
    artist: r.artist,
    title: r.title,
    remix: r.remix ?? undefined,
    bpm: num(r.bpm),
    camelot: r.camelot ?? undefined,
    energy: num(r.energy),
    danceability: num(r.danceability),
    popularity: num(r.popularity),
    isrc: r.isrc ?? undefined,
    previewUrl: r.preview_url ?? undefined,
    itunesUrl: r.itunes_url ?? undefined,
    artworkUrl: r.artwork_url ?? undefined,
    youtubeUrl: r.youtube_url ?? undefined,
    year: r.year ?? undefined,
    sources: (r.sources as Record<string, string> | null) ?? {},
  };
}

export function trackToRow(t: Track): Pick<TrackRow, 'id' | 'artist' | 'title'> & Partial<TrackRow> {
  return {
    id: t.id,
    artist: t.artist,
    title: t.title,
    remix: t.remix ?? null,
    bpm: t.bpm ?? null,
    camelot: t.camelot ?? null,
    energy: t.energy ?? null,
    danceability: t.danceability ?? null,
    popularity: t.popularity ?? null,
    isrc: t.isrc ?? null,
    preview_url: null, // preview URLs are short-lived; re-resolved on demand, never persisted
    itunes_url: t.itunesUrl ?? null,
    artwork_url: t.artworkUrl ?? null,
    youtube_url: t.youtubeUrl ?? null,
    year: t.year ?? null,
    sources: t.sources ?? {},
  };
}

