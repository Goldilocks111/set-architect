// Frozen contract for V2 Phase 2 (search). Change only via the integrator.
// See docs/superpowers/plans/2026-11-01-v2-phase2-search.md.

/** How a recording relates to the underlying work. */
export type VersionKind =
  | 'original' // "Original Mix" or no qualifier
  | 'extended' // "Extended Mix", "Club Mix"
  | 'radio' // "Radio Edit", "Edit"
  | 'remix' // "<X> Remix", "<X> Rework", "<X> Edit" by another artist, "Bootleg", "Flip"
  | 'vip'
  | 'dub'
  | 'live'
  | 'acoustic'
  | 'instrumental'
  | 'remaster'
  | 'other';

export interface ParsedVersion {
  /** Title with the version qualifier and featured-artist noise removed, e.g. "Cola". */
  baseTitle: string;
  kind: VersionKind;
  /** Human label as shown to users, e.g. "Extended Mix", "Disclosure Remix". Undefined for plain originals. */
  label?: string;
  /** Remixer / editor name when kind is 'remix' (or an artist-attributed edit). */
  remixer?: string;
  /** Featured artists pulled out of the title, e.g. ["Elderbrook"]. */
  featuring: string[];
}

/** One provider's hit, normalized. Providers fill what they know; nothing is invented. */
export interface SearchResult {
  provider: 'spotify' | 'deezer' | 'itunes';
  providerId: string;
  artist: string; // display string as the provider gives it (all main artists joined with ", ")
  artists: string[]; // individual main artists
  title: string; // raw provider title, unmodified
  version: ParsedVersion;
  isrc?: string;
  durationMs?: number;
  releaseDate?: string; // ISO yyyy-mm-dd (or yyyy) as provided
  popularity?: number; // 0..100 normalized per provider
  artworkUrl?: string;
  previewUrl?: string; // never persisted long-term
  spotifyId?: string;
  spotifyUrl?: string;
  explicit?: boolean;
}

export interface SearchProvider {
  name: SearchResult['provider'];
  /** Env-based; keyless providers return true. */
  configured(): boolean;
  /** Raw provider search. Must not throw on "no results" (return []); may throw on network/HTTP errors. */
  search(query: string, opts?: { limit?: number }): Promise<SearchResult[]>;
}

/** A work-level group in merged search: one entry per distinct recording (version) of a track. */
export interface MergedHit {
  /** Stable key: isrc when known, else normalized artist|baseTitle|versionKind|remixer. */
  key: string;
  artist: string;
  baseTitle: string;
  version: ParsedVersion;
  isrc?: string;
  durationMs?: number;
  releaseDate?: string;
  popularity?: number;
  artworkUrl?: string;
  previewUrl?: string;
  spotifyId?: string;
  spotifyUrl?: string;
  /** Which providers returned this recording (dedup evidence). */
  providers: SearchResult['provider'][];
  /** Ranking score used for ordering (higher first). */
  score: number;
}

export interface MergedSearchResponse {
  hits: MergedHit[];
  /** Providers that failed or timed out for this query (UI may show a soft warning). */
  degraded: SearchResult['provider'][];
}
