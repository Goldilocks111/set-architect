import type { Track } from '@/types/track';
import { fetchJson } from '../http';
import { keyNameToCamelot } from './camelot';
import type { SourceAdapter } from './types';

interface GsbHit {
  tempo?: string | number;
  key_of?: string;
}

export const getSongBpmAdapter: SourceAdapter = {
  name: 'getsongbpm',
  configured: () => !!process.env.GETSONGBPM_API_KEY,
  async enrich(partial) {
    const key = process.env.GETSONGBPM_API_KEY;
    if (!key) return {};
    const lookup = `song:${partial.title} artist:${partial.artist}`;
    const data = await fetchJson<{ search?: GsbHit[] | { error?: string } }>(
      `https://api.getsong.co/search/?api_key=${encodeURIComponent(key)}&type=both&lookup=${encodeURIComponent(lookup)}`
    );
    const hit = Array.isArray(data.search) ? data.search[0] : undefined;
    if (!hit) return {};
    const out: Partial<Track> = {};
    const bpm = Number(hit.tempo);
    if (Number.isFinite(bpm) && bpm > 0) out.bpm = bpm;
    const camelot = hit.key_of ? keyNameToCamelot(hit.key_of) : undefined;
    if (camelot) out.camelot = camelot;
    return out;
  },
};
