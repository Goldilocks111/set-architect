// User-scoped Spotify Web API calls. Only playlist/profile endpoints: audio-features and
// recommendations are deprecated for new apps and are never called.
const BASE = "https://api.spotify.com/v1";

export class SpotifyApiError extends Error {
  constructor(
    public status: number,
    path: string,
  ) {
    super(`Spotify ${status} for ${path}`);
  }
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  trackCount: number;
}

export interface SpotifyPlaylistTrack {
  artist: string;
  title: string;
  spotifyId: string;
  spotifyUrl?: string;
  popularity?: number;
}

async function call<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new SpotifyApiError(res.status, path);
  return res.json() as Promise<T>;
}

export async function me(
  token: string,
): Promise<{ id: string; displayName: string }> {
  const d = await call<{ id: string; display_name?: string | null }>(
    token,
    "/me",
  );
  return { id: d.id, displayName: d.display_name || d.id };
}

export async function listPlaylists(token: string): Promise<SpotifyPlaylist[]> {
  const out: SpotifyPlaylist[] = [];
  let next: string | null = `${BASE}/me/playlists?limit=50`;
  for (let page = 0; next && page < 10; page++) {
    const d: {
      items?: Array<{
        id: string;
        name: string;
        tracks?: { total?: number };
      } | null>;
      next?: string | null;
    } = await call(token, next);
    for (const p of d.items ?? [])
      if (p)
        out.push({ id: p.id, name: p.name, trackCount: p.tracks?.total ?? 0 });
    next = d.next ?? null;
  }
  return out;
}

interface RawTrack {
  id?: string | null;
  name?: string;
  popularity?: number;
  type?: string;
  is_local?: boolean;
  external_urls?: { spotify?: string };
  artists?: Array<{ name: string }>;
}

// Spotify renamed playlist `/tracks` to `/items` (and the item's `track` field to `item`) for newer
// apps; try the new shape first and fall back to the legacy one on 404.
interface RawItem {
  item?: RawTrack | null;
  track?: RawTrack | null;
}

async function withItemsFallback<T>(
  token: string,
  base: string,
  init?: { method?: string; body?: unknown },
  query = "",
): Promise<T> {
  try {
    return await call<T>(token, `${base}/items${query}`, init);
  } catch (err) {
    if (err instanceof SpotifyApiError && err.status === 404)
      return call<T>(token, `${base}/tracks${query}`, init);
    throw err;
  }
}

export async function playlistTracks(
  token: string,
  playlistId: string,
): Promise<SpotifyPlaylistTrack[]> {
  const out: SpotifyPlaylistTrack[] = [];
  const base = `/playlists/${encodeURIComponent(playlistId)}`;
  let first = true;
  let next: string | null = null;
  for (let page = 0; (first || next) && page < 10; page++) {
    const d: { items?: RawItem[]; next?: string | null } = first
      ? await withItemsFallback(token, base, undefined, "?limit=100")
      : await call(token, next as string);
    first = false;
    for (const raw of d.items ?? []) {
      const t = raw.item ?? raw.track;
      // skip local files, removed tracks and podcast episodes: no usable Spotify id
      if (
        !t ||
        !t.id ||
        t.is_local ||
        (t.type && t.type !== "track") ||
        !t.name
      )
        continue;
      out.push({
        artist: (t.artists ?? []).map((a) => a.name).join(", "),
        title: t.name,
        spotifyId: t.id,
        spotifyUrl: t.external_urls?.spotify,
        popularity: typeof t.popularity === "number" ? t.popularity : undefined,
      });
    }
    next = d.next ?? null;
  }
  return out;
}

/** Creates a private playlist and adds the tracks (<=100 per request). Returns its open.spotify.com URL. */
export async function createPlaylist(
  token: string,
  name: string,
  spotifyIds: string[],
): Promise<string> {
  const pl = await call<{ id: string; external_urls?: { spotify?: string } }>(
    token,
    "/me/playlists",
    {
      method: "POST",
      body: { name, public: false, description: "Created with Set Architect" },
    },
  );
  const uris = spotifyIds.map((id) => `spotify:track:${id}`);
  for (let i = 0; i < uris.length; i += 100) {
    await withItemsFallback(token, `/playlists/${pl.id}`, {
      method: "POST",
      body: { uris: uris.slice(i, i + 100) },
    });
  }
  return (
    pl.external_urls?.spotify ?? `https://open.spotify.com/playlist/${pl.id}`
  );
}
