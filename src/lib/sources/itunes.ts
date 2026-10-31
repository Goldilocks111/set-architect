import type { Track } from '@/types/track';
import { fetchJson } from '../http';
import type { SourceAdapter } from './types';

interface ItunesResult {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  previewUrl?: string;
  trackViewUrl?: string;
  artworkUrl100?: string;
  releaseDate?: string;
}

const URL_BASE = 'https://itunes.apple.com/search';

function mapResult(r: ItunesResult): Partial<Track> {
  const out: Partial<Track> = {};
  if (r.previewUrl) out.previewUrl = r.previewUrl;
  if (r.trackViewUrl) out.itunesUrl = r.trackViewUrl;
  if (r.artworkUrl100) out.artworkUrl = r.artworkUrl100.replace('100x100', '600x600');
  const year = r.releaseDate ? parseInt(r.releaseDate.slice(0, 4), 10) : NaN;
  if (Number.isFinite(year)) out.year = year;
  return out;
}

async function query(term: string, limit: number): Promise<ItunesResult[]> {
  const data = await fetchJson<{ results?: ItunesResult[] }>(
    `${URL_BASE}?term=${encodeURIComponent(term)}&entity=song&limit=${limit}`
  );
  return data.results ?? [];
}

export async function itunesSearch(q: string, limit = 10): Promise<Track[]> {
  return (await query(q, limit)).map((r) => {
    const mapped = mapResult(r);
    return {
      id: `itunes-${r.trackId}`,
      artist: r.artistName ?? '',
      title: r.trackName ?? '',
      ...mapped,
      sources: Object.fromEntries(Object.keys(mapped).map((k) => [k, 'itunes'])),
    };
  });
}

export const itunesAdapter: SourceAdapter = {
  name: 'itunes',
  configured: () => true,
  async enrich(partial) {
    const results = await query(`${partial.artist} ${partial.title}`, 5);
    const a = partial.artist.toLowerCase();
    const hit = results.find((r) => {
      const got = r.artistName?.toLowerCase();
      return !!got && (got.includes(a) || a.includes(got));
    });
    return hit ? mapResult(hit) : {};
  },
};
