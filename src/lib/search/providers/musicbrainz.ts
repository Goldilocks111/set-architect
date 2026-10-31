import { escapeLucene, mbGet, musicBrainzQueueDelayMs } from '@/lib/sources/musicbrainz';
import type { SearchResultWithIsrcs } from '@/lib/search/merge';
import { parseVersion } from '@/lib/search/version';
import type { SearchProvider } from '@/lib/search/types';

interface MbRecording {
  id: string;
  title: string;
  length?: number;
  isrcs?: string[];
  'first-release-date'?: string;
  'artist-credit'?: Array<{ name: string; joinphrase?: string }>;
}

const boostWord = (w: string) =>
  w
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Lucene query for every recording of one work, with the asked version words as an optional boost:
 * the boost pulls "Latch (Extended Version)" from #41 to #1 while the remaining recordings still come back.
 */
export function musicbrainzWorkQuery(baseTitle: string, leadArtist: string, versionWords: string[]): string {
  const base = `+recording:"${escapeLucene(baseTitle)}" +artist:"${escapeLucene(leadArtist)}"`;
  const boost = versionWords.map(boostWord).filter(Boolean).join(' ');
  return boost ? `${base} recording:(${boost})^10` : base;
}

export function mapMusicBrainzRecording(r: MbRecording): SearchResultWithIsrcs {
  const artists = (r['artist-credit'] ?? []).map((a) => a.name).filter(Boolean);
  const out: SearchResultWithIsrcs = {
    provider: 'musicbrainz',
    providerId: r.id,
    artist: artists.join(', '),
    artists,
    title: r.title,
    version: parseVersion(r.title, artists),
  };
  if (r.isrcs?.length) {
    out.isrc = r.isrcs[0];
    out.isrcs = [...r.isrcs];
  }
  if (typeof r.length === 'number') out.durationMs = r.length;
  if (r['first-release-date']) out.releaseDate = r['first-release-date'];
  return out;
}

export const MAX_QUEUE_WAIT_MS = 1000;

/** Catalog metadata only (no previews or artwork): used to discover versions the streaming catalogs miss. */
export const musicbrainzSearchProvider: SearchProvider = {
  name: 'musicbrainz',
  configured: () => true,
  async search(query, opts) {
    // Searches share the 1 req/s queue with enrichment lookups; a search that would wait more than a
    // second gives up now rather than be sent after its caller has stopped waiting.
    if (musicBrainzQueueDelayMs() > MAX_QUEUE_WAIT_MS) throw new Error('musicbrainz queue is busy');
    const limit = Math.max(1, Math.min(opts?.limit ?? 25, 100));
    const data = await mbGet<{ recordings?: MbRecording[] }>(
      `/recording?fmt=json&limit=${limit}&query=${encodeURIComponent(query)}`
    );
    return (data.recordings ?? [])
      .filter((r) => r.id && r.title && (r['artist-credit'] ?? []).some((a) => a.name))
      .map(mapMusicBrainzRecording);
  },
};
