import type { Track } from '@/types/track';

const CAMELOT = /^([1-9]|1[0-2])[AB]$/;
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i;
const MAX_TEXT = 300;
const MAX_URL = 2000;
const MAX_STYLES = 10;
const MAX_STYLE_TEXT = 100;

/** http(s) URLs only; anything else (data:, javascript:, relative) is dropped. */
export function safeHttpUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v || v.length > MAX_URL) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const text = (v: unknown, max = MAX_TEXT) =>
  typeof v === 'string' && v.trim() && v.length <= max ? v : undefined;

/** Only open.spotify.com links: the link-out must not point anywhere else. */
function spotifyUrl(v: unknown): string | undefined {
  const url = safeHttpUrl(v);
  return url && url.startsWith('https://open.spotify.com/') ? url : undefined;
}

/** Style lanes: short non-empty strings, at most MAX_STYLES; anything else is dropped. */
function styles(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === 'string' && s.trim() !== '' && s.length <= MAX_STYLE_TEXT).slice(0, MAX_STYLES);
  return out.length ? out : undefined;
}

const numIn = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

/**
 * Shape- and range-checks a client-supplied track. Returns null when the identity fields
 * are unusable; invalid optional fields are dropped rather than rejecting the track.
 */
export function sanitizeTrack(v: unknown): Track | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = text(o.id, 200);
  const artist = text(o.artist);
  const title = text(o.title);
  if (!id || !artist || !title) return null;

  const camelot = typeof o.camelot === 'string' && CAMELOT.test(o.camelot) ? o.camelot : undefined;
  const year = numIn(o.year, 1900, 2100);
  const t: Track = {
    id,
    artist,
    title,
    remix: text(o.remix),
    version: text(o.version, 100),
    durationMs: numIn(o.durationMs, 1, 7_200_000), // same 2 h cap as manual overrides (overrideValidation)
    spotifyUrl: spotifyUrl(o.spotifyUrl),
    bpm: numIn(o.bpm, 40, 250),
    camelot,
    energy: numIn(o.energy, 1, 10),
    danceability: numIn(o.danceability, 0, 1),
    popularity: numIn(o.popularity, 0, 100),
    isrc: typeof o.isrc === 'string' && ISRC.test(o.isrc) ? o.isrc.toUpperCase() : undefined,
    previewUrl: safeHttpUrl(o.previewUrl),
    itunesUrl: safeHttpUrl(o.itunesUrl),
    artworkUrl: safeHttpUrl(o.artworkUrl),
    youtubeUrl: safeHttpUrl(o.youtubeUrl),
    year: year !== undefined && Number.isInteger(year) ? year : undefined,
    spotifyId: typeof o.spotifyId === 'string' && /^[A-Za-z0-9]{22}$/.test(o.spotifyId) ? o.spotifyId : undefined,
    styles: styles(o.styles),
    sources: {},
  };

  const fields = new Set(Object.keys(t));
  if (o.sources && typeof o.sources === 'object' && !Array.isArray(o.sources)) {
    for (const [k, s] of Object.entries(o.sources as Record<string, unknown>)) {
      const name = text(s, 40);
      if (fields.has(k) && name && t[k as keyof Track] !== undefined) t.sources[k] = name;
    }
  }
  for (const k of Object.keys(t) as Array<keyof Track>) if (t[k] === undefined) delete t[k];
  return t;
}
