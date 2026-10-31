import { escapeLucene, mbGet } from '@/lib/sources/musicbrainz';
import { parseVersion } from '@/lib/search/version';
import type { SearchProvider, SearchResult } from '@/lib/search/types';

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

export function mapMusicBrainzRecording(r: MbRecording): SearchResult {
  const artists = (r['artist-credit'] ?? []).map((a) => a.name).filter(Boolean);
  const out: SearchResult = {
    provider: 'musicbrainz',
    providerId: r.id,
    artist: artists.join(', '),
    artists,
    title: r.title,
    version: parseVersion(r.title, artists),
  };
  if (r.isrcs?.length) out.isrc = r.isrcs[0];
  if (typeof r.length === 'number') out.durationMs = r.length;
  if (r['first-release-date']) out.releaseDate = r['first-release-date'];
  return out;
}

/** Catalog metadata only (no previews or artwork): used to discover versions the streaming catalogs miss. */
export const musicbrainzSearchProvider: SearchProvider = {
  name: 'musicbrainz',
  configured: () => true,
  async search(query, opts) {
    const limit = Math.max(1, Math.min(opts?.limit ?? 25, 100));
    const data = await mbGet<{ recordings?: MbRecording[] }>(
      `/recording?fmt=json&limit=${limit}&query=${encodeURIComponent(query)}`
    );
    return (data.recordings ?? []).filter((r) => r.id && r.title).map(mapMusicBrainzRecording);
  },
};
