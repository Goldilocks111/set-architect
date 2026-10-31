// Frozen contract — change only via the integrator (see docs/superpowers/plans/2026-10-31-set-architect-v1.md)

export interface Track {
  id: string;
  artist: string;
  title: string;
  remix?: string;
  bpm?: number;
  camelot?: string; // "1A".."12A" / "1B".."12B"
  energy?: number; // 1..10 (Mixed In Key scale)
  danceability?: number; // 0..1
  popularity?: number; // 0..100
  isrc?: string;
  spotifyId?: string; // when known (e.g. via ListenBrainz mapping); SoundStat/ReccoBeats key off it
  previewUrl?: string;
  itunesUrl?: string;
  artworkUrl?: string;
  youtubeUrl?: string;
  year?: number;
  sources: Record<string, string>; // field name -> source adapter name
}

export interface SuggestionReason {
  kind: 'key' | 'bpm' | 'energy' | 'cooccurrence' | 'similarity';
  label: string;
  score: number; // 0..1 contribution before weighting
}

export interface Suggestion {
  track: Track;
  score: number;
  reasons: SuggestionReason[];
}

export type ArcTemplate = '60min' | '120min';

export interface Weights {
  key: number;
  bpm: number;
  energy: number;
  cooccurrence: number;
  similarity: number;
}

export interface AdjacencyLookup {
  getNeighbors(
    trackKey: string
  ): Promise<Array<{ trackKey: string; count: number; direction: 'before' | 'after' }>>;
}

export interface SimilarityLookup {
  getSimilar(
    artist: string,
    title: string
  ): Promise<Array<{ artist: string; title: string; match: number }>>;
}

/** Normalized join key used across scraper index, engine and resolver. */
export function trackKeyOf(artist: string, title: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\(.*?(original mix|extended mix|radio edit).*?\)/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return `${norm(artist)}|${norm(title)}`;
}
