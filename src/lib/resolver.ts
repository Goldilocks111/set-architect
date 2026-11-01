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
import { cooldownUntil, recordFailure, recordSuccess, takeBudget } from './search/breaker';
import { defaultProviders, firstRoundProviders, mergedSearch } from './search/merge';
import type { MergedHit } from './search/types';

export const ADAPTER_TIMEOUT_MS = 4000;

const GUARDED = new Set<string>(['spotify', 'deezer', 'itunes', 'musicbrainz']);
const isGuarded = (name: string): name is MergedHit['providers'][number] => GUARDED.has(name);

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
    const guarded = isGuarded(adapter.name) ? adapter.name : undefined;
    try {
      if (!adapter.configured()) continue;
      // Enrichment shares the search providers' breaker and the app's Spotify budget: one add or a
      // suggestion refresh must not walk back into a lockout.
      if (guarded && (cooldownUntil(guarded) || !takeBudget(guarded, { app: true }))) continue;
      const partial = await withTimeout(adapter.enrich({ ...track }), adapter.timeoutMs ?? ADAPTER_TIMEOUT_MS, adapter.name);
      if (guarded) recordSuccess(guarded);
      if (adapter.name === 'deezer') deezerPreview = partial?.previewUrl;
      const overrides = OVERRIDES[adapter.name] ?? [];
      for (const [field, value] of Object.entries(partial ?? {}) as Array<[keyof Track, unknown]>) {
        if (value === undefined || value === null || field === 'sources' || field === 'id') continue;
        if (track[field] !== undefined && !overrides.includes(field)) continue;
        (track as unknown as Record<string, unknown>)[field] = value;
        track.sources[field] = adapter.fieldLabels?.[field] ?? adapter.name;
      }
    } catch (err) {
      if (guarded) recordFailure(guarded, err);
      // a failing adapter is skipped; resolution continues with the rest
    }
  }
  // Last resort: estimate from the Deezer preview (never iTunes: Apple's terms restrict preview use).
  const missing = (['bpm', 'camelot', 'energy', 'danceability'] as const).filter((f) => track[f] === undefined);
  if (missing.length && deezerPreview) {
    try {
      const partial = await withTimeout(analysePreview(track.id, deezerPreview), ANALYSIS_TIMEOUT_MS, 'preview-analysis');
      for (const f of missing) {
        const value = partial[f];
        if (value === undefined) continue;
        (track as unknown as Record<string, unknown>)[f] = value;
        track.sources[f] = 'preview-analysis';
      }
    } catch {
      // analysis is best-effort
    }
  }
  return track;
}

/** Stable across searches: the ISRC, else the merge key without the per-response "#n" collision suffix. */
export function trackIdOf(hit: MergedHit): string {
  return (hit.isrc ? `isrc-${hit.isrc}` : `search-${hit.key.replace(/#\d+$/, '')}`).slice(0, 200);
}

/** Maps one merged search hit to a Track; the title keeps the version so enrichment finds this exact recording. */
export function hitToTrack(hit: MergedHit, id = trackIdOf(hit)): Track {
  const label = hit.version.label;
  const track: Track = {
    id,
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
  const providers = defaultProviders().filter((p) => p.configured());
  const { hits, degraded } = await cachedMergedSearch(query, (q) => mergedSearch(q, { providers, appBudget: true }));
  const first = firstRoundProviders(providers);
  const asked = first.length ? first : providers;
  if (!hits.length && asked.length && asked.every((p) => degraded.includes(p.name))) return searchDemoTracks(query);
  const used = new Set<string>();
  return hits.map((hit) => {
    let id = trackIdOf(hit);
    if (used.has(id)) id = `search-${hit.key}`.slice(0, 200); // a genuine collision keeps its suffix
    used.add(id);
    return hitToTrack(hit, id);
  });
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
