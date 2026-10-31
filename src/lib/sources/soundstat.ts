import { fetchJson } from '../http';
import { mapFeatures, type RawFeatures } from './features';
import type { SourceAdapter } from './types';

// GET /api/v1/track/{spotify_track_id}; name search does not exist, so this needs partial.spotifyId.
export const soundstatAdapter: SourceAdapter = {
  name: 'soundstat',
  configured: () => !!process.env.SOUNDSTAT_API_KEY,
  async enrich(partial) {
    const key = process.env.SOUNDSTAT_API_KEY;
    if (!key || !partial.spotifyId) return {};
    const data = await fetchJson<{ features?: RawFeatures | null }>(
      `https://soundstat.info/api/v1/track/${encodeURIComponent(partial.spotifyId)}`,
      { headers: { 'x-api-key': key } }
    );
    // features is null while the track is still being analysed.
    return data.features ? mapFeatures(data.features) : {};
  },
};
