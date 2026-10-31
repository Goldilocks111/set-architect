'use client';

import type { DragEvent } from 'react';
import type { Track } from '@/types/track';
import { displayTitle, energyColor, fmtBpm, fmtEnergy, youtubeHref } from './trackFormat';

interface Props {
  track: Track;
  index: number;
  count: number;
  onRemove: (id: string) => void;
  onMove: (from: number, to: number) => void;
  dragOver: boolean;
  onDragStart: (index: number) => void;
  onDragOverRow: (index: number) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
}

const iconBtn =
  'grid h-7 w-7 place-items-center rounded text-[#8A8FA3] hover:bg-[#232838] hover:text-[#E8E4DA] disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#F2B33D]';

export default function SetRow({
  track,
  index,
  count,
  onRemove,
  onMove,
  dragOver,
  onDragStart,
  onDragOverRow,
  onDrop,
  onDragEnd,
}: Props) {
  const title = displayTitle(track);
  const energyKnown = typeof track.energy === 'number' && Number.isFinite(track.energy);
  return (
    <li
      draggable
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(index);
      }}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        onDragOverRow(index);
      }}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        onDrop(index);
      }}
      onDragEnd={onDragEnd}
      className={`group grid cursor-grab grid-cols-[28px_8px_1fr_auto] sm:grid-cols-[36px_8px_1fr_auto] items-center gap-x-3 rounded-lg px-2 py-2 active:cursor-grabbing ${
        dragOver ? 'bg-[#232838] ring-1 ring-[#F2B33D]/50' : 'hover:bg-[#1F2330]'
      }`}
    >
      <span className="text-right font-[family-name:var(--font-display)] text-lg leading-none text-[#8A8FA3] tabular-nums">
        {index + 1}
      </span>
      <span
        aria-hidden
        className="h-9 w-2 rounded-sm"
        style={{
          background: energyKnown
            ? `linear-gradient(to top, ${energyColor(track.energy)} ${(track.energy! / 10) * 100}%, #232838 ${(track.energy! / 10) * 100}%)`
            : 'repeating-linear-gradient(to top, #2A2F3F 0 3px, transparent 3px 6px)',
        }}
      />
      <div className="min-w-0">
        <div className="truncate font-[family-name:var(--font-display)] text-[15px] leading-tight font-semibold text-[#E8E4DA]">
          {title}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 text-[12.5px] text-[#8A8FA3] tabular-nums sm:flex-nowrap">
          <span className="basis-full truncate sm:basis-auto">{track.artist}</span>
          <span className="shrink-0 rounded bg-[#232838] px-1.5 text-[11.5px] leading-[18px] text-[#C9CEDF]">
            {track.camelot ?? 'key ?'}
          </span>
          <span className="shrink-0">{fmtBpm(track.bpm)} BPM</span>
          <span className="shrink-0">E{fmtEnergy(track.energy)}</span>
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-100 sm:opacity-40 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        {track.spotifyUrl && (
          <a
            href={track.spotifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${title} in Spotify`}
            className={`${iconBtn} max-sm:hidden`}
          >
            <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.2 10.1a.45.45 0 0 1-.62.15c-1.7-1.04-3.84-1.27-6.36-.7a.45.45 0 1 1-.2-.88c2.76-.63 5.14-.36 7.03.8.21.13.28.41.15.63zm.88-1.96a.56.56 0 0 1-.77.18c-1.94-1.2-4.9-1.54-7.2-.84a.56.56 0 0 1-.32-1.07c2.62-.8 5.88-.41 8.11.96.26.16.34.5.18.77zm.08-2.04C9.83 6.7 6 6.57 3.8 7.24a.67.67 0 1 1-.39-1.28c2.53-.77 6.76-.62 9.43 1 .32.19.42.6.23.92a.67.67 0 0 1-.91.23z" />
            </svg>
          </a>
        )}
        <a
          href={youtubeHref(track)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Find ${title} on YouTube`}
          className={`${iconBtn} max-sm:hidden`}
        >
          <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
            <path d="M6 4.5v7l5.5-3.5z" />
          </svg>
        </a>
        <button type="button" className={iconBtn} disabled={index === 0} onClick={() => onMove(index, index - 1)} aria-label={`Move ${title} up`}>
          <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M8 4l5 6H3z" /></svg>
        </button>
        <button type="button" className={iconBtn} disabled={index === count - 1} onClick={() => onMove(index, index + 1)} aria-label={`Move ${title} down`}>
          <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M8 12L3 6h10z" /></svg>
        </button>
        <button type="button" className={iconBtn} onClick={() => onRemove(track.id)} aria-label={`Remove ${title} from the set`}>
          <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 stroke-current" strokeWidth="1.8" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
    </li>
  );
}
