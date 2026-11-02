import type { Track } from '@/types/track';
import { titleMatches } from './match';
import { fetchJson, fetchWithTimeout, HttpError } from '../http';
import type { SourceAdapter } from './types';

// Catalog search only (id + link-out): Spotify's audio-features, recommendations and preview_url are
// deprecated for new apps and are deliberately never called.
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';

interface SpotifyTrack {
  id: string;
  name?: string;
  popularity?: number;
  external_urls?: { spotify?: string };
  external_ids?: { isrc?: string };
  artists?: Array<{ name: string }>;
}

let cached: { token: string; expiresAt: number } | undefined;

const creds = () => {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  return id && secret ? { id, secret } : undefined;
};

export async function getToken(force = false): Promise<string> {
  if (!force && cached && Date.now() < cached.expiresAt) return cached.token;
  const c = creds();
  if (!c) throw new Error('spotify not configured');
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('spotify token response missing access_token');
  cached = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000 };
  return cached.token;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function artistMatches(wanted: string, got?: string): boolean {
  const a = norm(wanted);
  const b = norm(got ?? '');
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

async function search(q: string): Promise<SpotifyTrack[]> {
  const url = `${SEARCH_URL}?type=track&limit=5&q=${encodeURIComponent(q)}`;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(attempt > 0);
    try {
      const data = await fetchJson<{ tracks?: { items?: SpotifyTrack[] } }>(url, {
        headers: { Authorization: `Bearer ${token}` },
        retries: 0,
      });
      return data.tracks?.items ?? [];
    } catch (err) {
      // a stale cached token: refresh once, then give up
      if (err instanceof HttpError && err.status === 401 && attempt === 0) continue;
      throw err;
    }
  }
}

/** Test hook: drop the module-level token cache. */
export function resetSpotifyTokenCache() {
  cached = undefined;
}

export const spotifyAdapter: SourceAdapter = {
  name: 'spotify',
  configured: () => !!creds(),
  async enrich(partial) {
    const items = await search(`${partial.artist} ${partial.title}`);
    const hit = items.find((t) => t.artists?.some((a) => artistMatches(partial.artist, a.name)) && titleMatches(partial.title, t.name));
    if (!hit) return {};
    const out: Partial<Track> = { spotifyId: hit.id };
    if (hit.name && hit.artists?.[0]?.name) Object.assign(out, { artist: hit.artists[0].name, title: hit.name }); // display name only
    if (hit.external_urls?.spotify) out.spotifyUrl = hit.external_urls.spotify;
    if (partial.popularity === undefined && typeof hit.popularity === 'number') out.popularity = hit.popularity;
    if (partial.isrc === undefined && hit.external_ids?.isrc) out.isrc = hit.external_ids.isrc;
    return out;
  },
};
