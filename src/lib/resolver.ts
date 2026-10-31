import { trackKeyOf, type Track } from '@/types/track';
import { searchDemoTracks } from './demo';
import { withTimeout } from './http';
import { analysePreview, ANALYSIS_TIMEOUT_MS } from './analysis/previewAnalysis';
import { acousticbrainzAdapter } from './sources/acousticbrainz';
import { deezerAdapter } from './sources/deezer';
import { getSongBpmAdapter } from './sources/getsongbpm';
import { itunesAdapter } from './sources/itunes';
import { lastfmConfigured, lastfmSimilar, type SimilarItem } from './sources/lastfm';
import { listenbrainzSimilar } from './sources/listenbrainz';
import { musicbrainzAdapter } from './sources/musicbrainz';
import { reccobeatsAdapter } from './sources/reccobeats';
import { soundstatAdapter } from './sources/soundstat';
import { spotifyAdapter } from './sources/spotify';
import type { SourceAdapter } from './sources/types';
import { youtubeAdapter } from './sources/youtube';
import { cachedMergedSearch } from './search/cache';
import { firstRoundProviders, mergedSearch } from './search/merge';
import { searchProviders } from './search/providers';
import type { MergedHit } from './search/types';

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

/** Maps one merged search hit to a Track; the title keeps the version so enrichment finds this exact recording. */
export function hitToTrack(hit: MergedHit): Track {
  const label = hit.version.label;
  const track: Track = {
    id: (hit.isrc ? `isrc-${hit.isrc}` : `search-${hit.key}`).slice(0, 200),
    artist: hit.artist,
    title: label ? `${hit.baseTitle} (${label})` : hit.baseTitle,
    sources: {},
  };
  const year = hit.releaseDate ? parseInt(hit.releaseDate.slice(0, 4), 10) : NaN;
  const fields: Partial<Track> = {
    version: label,
    durationMs: hit.durationMs,
    isrc: hit.isrc,
    popularity: hit.popularity,
    spotifyId: hit.spotifyId,
    spotifyUrl: hit.spotifyUrl,
    previewUrl: hit.previewUrl,
    artworkUrl: hit.artworkUrl,
    year: Number.isFinite(year) && year > 0 ? year : undefined,
  };
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    (track as unknown as Record<string, unknown>)[field] = value;
    if (field !== 'version' && field !== 'durationMs') track.sources[field] = hit.providers.join('+');
  }
  return track;
}

export async function searchTracks(query: string): Promise<Track[]> {
  const providers = searchProviders.filter((p) => p.configured());
  const { hits, degraded } = await cachedMergedSearch(query, (q) => mergedSearch(q, { providers }));
  const first = firstRoundProviders(providers);
  if (!hits.length && first.every((p) => degraded.includes(p.name))) return searchDemoTracks(query);
  return hits.map(hitToTrack);
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
