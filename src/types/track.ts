import type { Essential, IncompleteReason } from '@/lib/completeness';

// Frozen contract — change only via the integrator (see docs/superpowers/plans/2026-10-31-set-architect-v1.md)

export interface Track {
  id: string;
  artist: string;
  title: string;
  remix?: string;
  version?: string; // version label from search ("Extended Mix", "Mark Knight Remix"); absent for plain originals
  durationMs?: number;
  bpm?: number;
  camelot?: string; // "1A".."12A" / "1B".."12B"
  energy?: number; // 1..10 (Mixed In Key scale)
  danceability?: number; // 0..1
  popularity?: number; // 0..100
  isrc?: string;
  mbid?: string; // MusicBrainz recording id (via musicbrainz adapter); AcousticBrainz keys off it
  spotifyId?: string; // when known (via Spotify search adapter); SoundStat/ReccoBeats key off it
  spotifyUrl?: string; // open.spotify.com link for link-out
  previewUrl?: string;
  itunesUrl?: string;
  artworkUrl?: string;
  youtubeUrl?: string;
  year?: number;
  styles?: string[]; // up to 3 DJ lanes (see lib/style/taxonomy), from Last.fm tags; not an essential
  sources: Record<string, string>; // field name -> source adapter name
  unresolved?: { reason: IncompleteReason; missing: Essential[]; retryAt?: number }; // set when an essential is missing
}

export interface SuggestionReason {
  kind: 'key' | 'bpm' | 'energy' | 'cooccurrence' | 'similarity' | 'style';
  label: string;
  score: number; // 0..1 contribution before weighting
}

export interface Suggestion {
  track: Track;
  score: number;
  reasons: SuggestionReason[];
  /** Criterion 3: key-compatible AND within ±6% tempo AND energy toward the arc target (engine/compliance). */
  compliant?: boolean;
}

/** Energy-arc shape over the set's minutes (rulebook §3): 'build' = the 60-min curve, 'journey' = the 120-min curve. */
export type ArcShape = 'build' | 'journey' | 'warm-up' | 'peak-time';

/** The planned set: its length in minutes and the energy shape stretched over it. */
export type Arc = { minutes: number; shape: ArcShape };

export interface Weights {
  key: number;
  bpm: number;
  energy: number;
  cooccurrence: number;
  similarity: number;
  style: number;
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

/** Qualifier words that describe a length or mastering of the same recording, not a different track. */
const SAME_TRACK_WORDS = new Set([
  'original', 'extended', 'radio', 'club', 'edit', 'version', 'mix', 'remaster', 'remastered', 'short', 'single',
  'album', 'main', 'long', 'full', 'length', 'explicit', 'clean', 'mono', 'stereo', 'digital',
]);

/** "(Extended)", "[2014 Remaster]", "Radio Edit": yes. "(Mark Knight Remix)", "(Dub Mix)": no. */
export function isSameTrackQualifier(inner: string): boolean {
  const words = inner.split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => SAME_TRACK_WORDS.has(w) || /^(19|20)\d\d$/.test(w));
}

/** Normalized join key used across scraper index, engine and resolver. */
export function trackKeyOf(artist: string, title: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\(.*?(original mix|extended mix|radio edit).*?\)/g, '')
      .replace(/[([]([^()[\]]*)[)\]]/g, (whole, inner: string) => (isSameTrackQualifier(inner) ? '' : whole))
      .replace(/\s+[-–—]\s+([^-–—]*)$/, (whole, inner: string) => (isSameTrackQualifier(inner) ? '' : whole))
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return `${norm(artist)}|${norm(title)}`;
}
