import type { Track } from '@/types/track';
import { titleMatches } from './match';
import { fetchJson } from '../http';
import type { SourceAdapter } from './types';

const BASE = 'https://api.deezer.com';

interface DeezerTrack {
  id: number;
  title: string;
  rank?: number;
  preview?: string;
  isrc?: string;
  release_date?: string;
  artist?: { name: string };
  album?: { cover_medium?: string; cover_big?: string };
}

// previewUrl is a signed URL that expires in ~15 minutes: never persist it long-term.
const popularityFromRank = (rank?: number) =>
  typeof rank === 'number' && rank > 0 ? Math.min(100, Math.round(rank / 10_000)) : undefined;

// Deezer's `bpm` field is 0 in practice and is deliberately never mapped.
function mapTrack(t: DeezerTrack): Partial<Track> {
  const out: Partial<Track> = {};
  const pop = popularityFromRank(t.rank);
  if (pop !== undefined) out.popularity = pop;
  if (t.preview) out.previewUrl = t.preview;
  if (t.isrc) out.isrc = t.isrc;
  const art = t.album?.cover_big ?? t.album?.cover_medium;
  if (art) out.artworkUrl = art;
  const year = t.release_date ? parseInt(t.release_date.slice(0, 4), 10) : NaN;
  if (Number.isFinite(year) && year > 0) out.year = year;
  return out;
}

export async function deezerSearch(query: string, limit = 10): Promise<Track[]> {
  const data = await fetchJson<{ data?: DeezerTrack[] }>(
    `${BASE}/search?q=${encodeURIComponent(query)}&limit=${limit}`
  );
  return (data.data ?? []).map((t) => {
    const mapped = mapTrack(t);
    return {
      id: `deezer-${t.id}`,
      artist: t.artist?.name ?? '',
      title: t.title,
      ...mapped,
      sources: Object.fromEntries(Object.keys(mapped).map((k) => [k, 'deezer'])),
    };
  });
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function artistMatches(wanted: string, got?: string): boolean {
  const a = norm(wanted);
  const b = norm(got ?? '');
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

async function findHit(partial: Track): Promise<DeezerTrack | undefined> {
  // Plain query first: the fielded artist:"" track:"" syntax returned 0 results live.
  const attempts = [
    `${partial.artist} ${partial.title}`,
    `artist:"${partial.artist}" track:"${partial.title}"`,
  ];
  for (const q of attempts) {
    try {
      const res = await fetchJson<{ data?: DeezerTrack[] }>(
        `${BASE}/search?q=${encodeURIComponent(q)}&limit=5`
      );
      const hit = (res.data ?? []).find((t) => artistMatches(partial.artist, t.artist?.name) && titleMatches(partial.title, t.title, partial.artist));
      if (hit) return hit;
    } catch (err) {
      if (q === attempts[0]) throw err;
    }
  }
  return undefined;
}

export const deezerAdapter: SourceAdapter = {
  name: 'deezer',
  configured: () => true,
  async enrich(partial) {
    const hit = await findHit(partial);
    if (!hit) return {};
    const out = mapTrack(hit);
    // the provider's own spelling: the resolver keeps it as the display name (it never replaces the caller's artist/title)
    if (hit.artist?.name && hit.title) Object.assign(out, { artist: hit.artist.name, title: hit.title });
    try {
      // Search results omit release_date; the track endpoint has it.
      const detail = await fetchJson<DeezerTrack>(`${BASE}/track/${hit.id}`);
      Object.assign(out, mapTrack({ ...hit, ...detail }));
    } catch {
      // detail is best-effort
    }
    return out;
  },
};
