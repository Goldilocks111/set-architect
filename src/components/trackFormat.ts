import type { SuggestionReason, Track } from '@/types/track';
import { safeHttpUrl } from './trackSanitize';

export const youtubeHref = (t: Track) =>
  safeHttpUrl(t.youtubeUrl) ??
  'https://www.youtube.com/results?search_query=' + encodeURIComponent(`${t.artist} ${t.title}`);

export const displayTitle = (t: Track) => (t.remix ? `${t.title} (${t.remix})` : t.title);

export const fmtBpm = (bpm: number | undefined) =>
  typeof bpm === 'number' && Number.isFinite(bpm) ? String(Math.round(bpm * 10) / 10) : '—';

export const fmtEnergy = (e: number | undefined) =>
  typeof e === 'number' && Number.isFinite(e) ? String(Math.round(e)) : '—';

export const pct = (score: number) => (Number.isFinite(score) ? Math.round(Math.max(0, Math.min(1, score)) * 100) : 0);

export type Quality = 'good' | 'ok' | 'poor' | 'unknown';

export function quality(score: number | undefined): Quality {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'unknown';
  if (score >= 0.75) return 'good';
  if (score >= 0.4) return 'ok';
  return 'poor';
}

export const QUALITY_CLASSES: Record<Quality, string> = {
  good: 'text-[#7DD3A8] border-[#7DD3A8]/35 bg-[#7DD3A8]/10',
  ok: 'text-[#E9C46A] border-[#E9C46A]/35 bg-[#E9C46A]/10',
  poor: 'text-[#EE8B7A] border-[#EE8B7A]/35 bg-[#EE8B7A]/10',
  unknown: 'text-[#8A8FA3] border-[#2A2F3F] bg-transparent',
};

export const REASON_KIND_LABEL: Record<SuggestionReason['kind'], string> = {
  key: 'Key',
  bpm: 'Tempo',
  energy: 'Energy',
  cooccurrence: 'In real sets',
  similarity: 'Similar',
};

/** Energy 1..10 mapped onto a cool→warm ramp so the chip reads like a level meter. */
export function energyColor(e: number | undefined): string {
  if (typeof e !== 'number' || !Number.isFinite(e)) return '#3A4054';
  const ramp = ['#4C6EA8', '#4C6EA8', '#5B86B8', '#6E9FC0', '#8FB4B0', '#C9BE7A', '#E8B04A', '#F29A3D', '#F07A3A', '#EC5B3B'];
  return ramp[Math.max(0, Math.min(9, Math.round(e) - 1))];
}

export type PreviewSource = 'itunes' | 'deezer' | 'other';

/** Attribution must match where the preview audio actually comes from. */
export function previewSource(t: Track): PreviewSource {
  const src = t.sources?.previewUrl;
  if (src === 'itunes' || src === 'deezer') return src;
  if (t.previewUrl && /(^https?:\/\/)?[^/]*(apple|itunes|mzstatic)\.com/.test(t.previewUrl)) return 'itunes';
  if (t.previewUrl && /dzcdn\.net|deezer\.com/.test(t.previewUrl)) return 'deezer';
  return 'other';
}

export const needsMetadata = (t: Track) => t.bpm === undefined || t.camelot === undefined || t.energy === undefined;

export async function fetchResolved(t: Pick<Track, 'artist' | 'title'>, signal?: AbortSignal): Promise<Track | null> {
  try {
    const qs = new URLSearchParams({ artist: t.artist, title: t.title });
    const res = await fetch(`/api/search/resolve?${qs}`, { signal });
    if (!res.ok) return null;
    return ((await res.json()) as { track?: Track }).track ?? null;
  } catch {
    return null;
  }
}
