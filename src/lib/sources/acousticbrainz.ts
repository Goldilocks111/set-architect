import type { Track } from '@/types/track';
import { fetchJson } from '../http';
import { keyScaleToCamelot } from './camelot';
import type { SourceAdapter } from './types';

const BASE = 'https://acousticbrainz.org/api/v1';

interface LowLevel {
  rhythm?: { bpm?: number };
  tonal?: { key_key?: string; key_scale?: string };
  lowlevel?: { average_loudness?: number };
}
interface HighLevel {
  highlevel?: { danceability?: { all?: { danceable?: number } } };
}

/** Responses are keyed by the (possibly redirected) mbid, plus a "mbid_mapping" entry; each value is {"0": doc}. */
function firstDoc<T>(res: Record<string, unknown> | undefined, mbid: string): T | undefined {
  if (!res) return undefined;
  const entry = (res[mbid] ?? Object.entries(res).find(([k]) => k !== 'mbid_mapping')?.[1]) as
    | Record<string, T>
    | undefined;
  return entry && typeof entry === 'object' ? entry['0'] : undefined;
}

/** AcousticBrainz average_loudness is 0..1; spread onto the 1..10 energy scale. Only an estimate. */
function energyFromLoudness(l: number): number {
  return Math.min(10, Math.max(1, Math.round(1 + l * 9)));
}

export const acousticbrainzAdapter: SourceAdapter = {
  name: 'acousticbrainz',
  timeoutMs: 6000,
  fieldLabels: { energy: 'acousticbrainz-estimate' },
  configured: () => true,
  async enrich(partial: Track) {
    if (!partial.mbid) return {};
    const id = encodeURIComponent(partial.mbid);
    const [low, high] = await Promise.all([
      fetchJson<Record<string, unknown>>(`${BASE}/low-level?recording_ids=${id}`, { timeoutMs: 5500, retries: 0 }).catch(
        () => undefined
      ),
      fetchJson<Record<string, unknown>>(`${BASE}/high-level?recording_ids=${id}`, { timeoutMs: 5500, retries: 0 }).catch(
        () => undefined
      ),
    ]);
    const out: Partial<Track> = {};
    const ll = firstDoc<LowLevel>(low, partial.mbid);
    const bpm = ll?.rhythm?.bpm;
    if (typeof bpm === 'number' && bpm > 0) out.bpm = Math.round(bpm * 10) / 10;
    if (ll?.tonal?.key_key && ll.tonal.key_scale) {
      const c = keyScaleToCamelot(ll.tonal.key_key, ll.tonal.key_scale);
      if (c) out.camelot = c;
    }
    const loud = ll?.lowlevel?.average_loudness;
    if (typeof loud === 'number' && Number.isFinite(loud) && partial.energy === undefined) {
      out.energy = energyFromLoudness(loud);
    }
    const dance = firstDoc<HighLevel>(high, partial.mbid)?.highlevel?.danceability?.all?.danceable;
    if (typeof dance === 'number' && dance >= 0 && dance <= 1) out.danceability = dance;
    return out;
  },
};
