import { fetchJson } from '../http';
import type { SimilarItem } from './lastfm';
import { escapeLucene, mbGet } from './musicbrainz';

const ALGORITHM = 'session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30';

/** Keyless fallback: MusicBrainz recording lookup → ListenBrainz labs similar-recordings (scores normalized to 0..1). */
export async function listenbrainzSimilar(artist: string, title: string): Promise<SimilarItem[]> {
  // the shared MusicBrainz limiter (1 req/s, mandatory User-Agent): this lookup competes with the resolver's
  const mb = await mbGet<{ recordings?: Array<{ id: string }> }>(
    `/recording?query=${encodeURIComponent(`artist:"${escapeLucene(artist)}" AND recording:"${escapeLucene(title)}"`)}&fmt=json&limit=1`
  );
  const mbid = mb.recordings?.[0]?.id;
  if (!mbid) return [];
  const rows = await fetchJson<Array<{ recording_name?: string; artist_credit_name?: string; score?: number }>>(
    `https://labs.api.listenbrainz.org/similar-recordings/json?recording_mbids=${mbid}&algorithm=${ALGORITHM}`
  );
  const valid = (Array.isArray(rows) ? rows : []).filter((r) => r.recording_name && r.artist_credit_name);
  const max = Math.max(1, ...valid.map((r) => r.score ?? 0));
  return valid.map((r) => ({
    artist: r.artist_credit_name as string,
    title: r.recording_name as string,
    match: Math.min(1, (r.score ?? 0) / max),
  }));
}
