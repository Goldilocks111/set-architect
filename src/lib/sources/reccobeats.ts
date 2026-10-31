import { fetchJson } from '../http';
import { mapFeatures, type RawFeatures } from './features';
import type { SourceAdapter } from './types';

// Keyless best-effort fill keyed by Spotify ID; the service has no SLA, so failures propagate to the resolver (which skips).
export const reccobeatsAdapter: SourceAdapter = {
  name: 'reccobeats',
  configured: () => true,
  async enrich(partial) {
    if (!partial.spotifyId) return {};
    const feats = await fetchJson<{ content?: RawFeatures[] }>(
      `https://api.reccobeats.com/v1/audio-features?ids=${encodeURIComponent(partial.spotifyId)}`,
      { retries: 0, timeoutMs: 3000 }
    );
    const f = feats.content?.[0];
    return f ? mapFeatures(f) : {};
  },
};
