import { trackKeyOf, type Track } from '@/types/track';
import { searchDemoTracks } from './demo';
import { withTimeout } from './http';
import { analysePreview, ANALYSIS_TIMEOUT_MS } from './analysis/previewAnalysis';
import { acousticbrainzAdapter } from './sources/acousticbrainz';
import { deezerAdapter, deezerSearch } from './sources/deezer';
import { getSongBpmAdapter } from './sources/getsongbpm';
import { itunesAdapter, itunesSearch } from './sources/itunes';
import { lastfmConfigured, lastfmSimilar, type SimilarItem } from './sources/lastfm';
import { listenbrainzSimilar } from './sources/listenbrainz';
import { musicbrainzAdapter } from './sources/musicbrainz';
import { reccobeatsAdapter } from './sources/reccobeats';
import { soundstatAdapter } from './sources/soundstat';
import { spotifyAdapter } from './sources/spotify';
import type { SourceAdapter } from './sources/types';
import { youtubeAdapter } from './sources/youtube';

export const ADAPTER_TIMEOUT_MS = 4000;

// youtube is appended last: keyless it only builds a search URL, so it costs nothing.
const ADAPTERS: SourceAdapter[] = [
  deezerAdapter,
  itunesAdapter,
  spotifyAdapter, // before soundstat/reccobeats: they key off the spotifyId it supplies
  getSongBpmAdapter,
  soundstatAdapter,
  reccobeatsAdapter,
  musicbrainzAdapter, // slow + 1 req/s: last, fills whatever is still missing
  acousticbrainzAdapter, // needs the mbid from musicbrainz
  youtubeAdapter,
];

// Fields where a given adapter may replace an earlier source's value: SoundStat's analysis beats earlier
// bpm/key estimates, and iTunes is the preferred previewUrl (Deezer's expires in ~15 min and is only a fallback).
// previewUrl must not be persisted long-term.
const OVERRIDES: Record<string, Array<keyof Track>> = { soundstat: ['bpm', 'camelot'], itunes: ['previewUrl'] };

export async function resolveTrack(
  artist: string,
  title: string,
  hints: { spotifyId?: string } = {}
): Promise<Track> {
  const track: Track = { id: trackKeyOf(artist, title), artist, title, sources: {} };
  if (hints.spotifyId) {
    track.spotifyId = hints.spotifyId;
    track.sources.spotifyId = 'caller';
  }
  let deezerPreview: string | undefined;
  for (const adapter of ADAPTERS) {
    try {
      if (!adapter.configured()) continue;
      const partial = await withTimeout(adapter.enrich({ ...track }), adapter.timeoutMs ?? ADAPTER_TIMEOUT_MS, adapter.name);
      if (adapter.name === 'deezer') deezerPreview = partial?.previewUrl;
      const overrides = OVERRIDES[adapter.name] ?? [];
      for (const [field, value] of Object.entries(partial ?? {}) as Array<[keyof Track, unknown]>) {
        if (value === undefined || value === null || field === 'sources' || field === 'id') continue;
        if (track[field] !== undefined && !overrides.includes(field)) continue;
        (track as unknown as Record<string, unknown>)[field] = value;
        track.sources[field] = adapter.fieldLabels?.[field] ?? adapter.name;
      }
    } catch {
      // a failing adapter is skipped; resolution continues with the rest
    }
  }
  // Last resort: estimate tempo from the Deezer preview (never iTunes: Apple's terms restrict preview use).
  if (track.bpm === undefined && deezerPreview) {
    try {
      const partial = await withTimeout(analysePreview(track.id, deezerPreview), ANALYSIS_TIMEOUT_MS, 'preview-analysis');
      if (partial.bpm !== undefined) {
        track.bpm = partial.bpm;
        track.sources.bpm = 'preview-analysis';
      }
    } catch {
      // analysis is best-effort
    }
  }
  return track;
}

export async function searchTracks(query: string): Promise<Track[]> {
  let failures = 0;
  for (const search of [deezerSearch, itunesSearch]) {
    try {
      const res = await withTimeout(search(query), ADAPTER_TIMEOUT_MS, 'search');
      if (res.length) return res;
    } catch {
      failures++;
    }
  }
  return failures === 2 ? searchDemoTracks(query) : [];
}

export async function getSimilarTracks(artist: string, title: string): Promise<SimilarItem[]> {
  if (lastfmConfigured()) {
    try {
      const res = await withTimeout(lastfmSimilar(artist, title), ADAPTER_TIMEOUT_MS, 'lastfm');
      if (res.length) return res;
    } catch {
      // fall through to ListenBrainz
    }
  }
  try {
    return await withTimeout(listenbrainzSimilar(artist, title), ADAPTER_TIMEOUT_MS, 'listenbrainz');
  } catch {
    return [];
  }
}

export function adapterHealth(): Array<{ name: string; configured: boolean }> {
  return [
    ...ADAPTERS.map((a) => ({ name: a.name, configured: a.configured() })),
    { name: 'lastfm', configured: lastfmConfigured() },
    { name: 'listenbrainz', configured: true },
  ];
}
