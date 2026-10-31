import type { Track } from '@/types/track';

/** "m:ss" for a duration in milliseconds; empty when unknown. */
export function fmtDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The title without its version suffix, so the chip carries the version instead of the text. */
export function baseTitleOf(t: Pick<Track, 'title' | 'version'>): string {
  const suffix = t.version ? ` (${t.version})` : '';
  return suffix && t.title.endsWith(suffix) ? t.title.slice(0, -suffix.length) : t.title;
}

const workKey = (t: Track) => `${t.artist}|${baseTitleOf(t)}`.toLowerCase();

/** Stable reorder that pulls every version of a work up next to its first (best-ranked) version. */
export function groupVersions(tracks: Track[]): Track[] {
  const order: string[] = [];
  const byWork = new Map<string, Track[]>();
  for (const t of tracks) {
    const k = workKey(t);
    if (!byWork.has(k)) {
      byWork.set(k, []);
      order.push(k);
    }
    byWork.get(k)!.push(t);
  }
  return order.flatMap((k) => byWork.get(k)!);
}

function tone(label: string): string {
  if (/\b(remix|rework|bootleg|flip|refix|edit)\b/i.test(label) && !/^radio edit$/i.test(label)) {
    return 'text-[#F2B33D] border-[#F2B33D]/35 bg-[#F2B33D]/10';
  }
  if (/\b(extended|club)\b/i.test(label)) return 'text-[#7DD3A8] border-[#7DD3A8]/35 bg-[#7DD3A8]/10';
  return 'text-[#C9CEDF] border-[#3A4054] bg-[#232838]';
}

export default function VersionChip({ label }: { label?: string }) {
  if (!label) return null;
  return (
    <span
      className={`inline-block max-w-[14rem] shrink-0 truncate rounded border px-1.5 py-px text-[11px] leading-4 ${tone(label)}`}
      title={label}
    >
      {label}
    </span>
  );
}
