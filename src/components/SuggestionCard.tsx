'use client';

import { useState } from 'react';
import type { Suggestion, Track } from '@/types/track';
import PreviewPlayer from './PreviewPlayer';
import {
  QUALITY_CLASSES,
  REASON_KIND_LABEL,
  displayTitle,
  energyColor,
  fetchResolved,
  fmtBpm,
  fmtEnergy,
  pct,
  previewSource,
  quality,
  youtubeHref,
} from './trackFormat';

interface Props {
  suggestion: Suggestion;
  onAdd: (track: Track) => void;
}

export default function SuggestionCard({ suggestion, onAdd }: Props) {
  const { reasons } = suggestion;
  const [found, setFound] = useState<Track | null>(null);
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'none'>('idle');
  const track: Track = found?.previewUrl
    ? { ...suggestion.track, previewUrl: found.previewUrl, itunesUrl: suggestion.track.itunesUrl ?? found.itunesUrl, sources: { ...suggestion.track.sources, previewUrl: found.sources?.previewUrl ?? 'other' } }
    : suggestion.track;
  const score = pct(suggestion.score);
  const title = displayTitle(track);

  return (
    <article className="group grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-2.5 border-b border-[#2A2F3F] py-3.5 last:border-b-0">
      <div
        aria-label={`Match score ${score} out of 100`}
        className="row-span-2 flex h-11 w-11 flex-col items-center justify-center rounded-full border-2 font-[family-name:var(--font-display)] tabular-nums"
        style={{ borderColor: `color-mix(in oklab, #F2B33D ${score}%, #2A2F3F)` }}
      >
        <span className="text-base leading-none font-semibold text-[#E8E4DA]">{score}</span>
      </div>

      <div className="min-w-0">
        <h3 className="truncate font-[family-name:var(--font-display)] text-[15px] leading-tight font-semibold text-[#E8E4DA]">
          {title}
        </h3>
        <p className="truncate text-[13px] text-[#8A8FA3]">{track.artist}</p>
      </div>

      <button
        type="button"
        onClick={() => onAdd(track)}
        aria-label={`Add ${title} to the set`}
        className="self-start rounded-md bg-[#F2B33D] px-3 py-1.5 text-[13px] font-semibold text-[#12141C] hover:bg-[#F6C567] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D]"
      >
        Add
      </button>

      <div className="col-span-2 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[#8A8FA3] tabular-nums">
          <span>
            <span className="text-[#E8E4DA]">{track.camelot ?? '—'}</span> key
          </span>
          <span>
            <span className="text-[#E8E4DA]">{fmtBpm(track.bpm)}</span> BPM
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: energyColor(track.energy) }} />
            <span className="text-[#E8E4DA]">{fmtEnergy(track.energy)}</span> energy
          </span>
        </div>

        {reasons.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Why this track">
            {reasons.map((r, i) => (
              <li
                key={`${r.kind}-${i}`}
                data-kind={r.kind}
                className={`inline-flex items-baseline gap-1.5 rounded border px-1.5 py-0.5 text-[11.5px] leading-snug ${QUALITY_CLASSES[quality(r.score)]}`}
              >
                <span className="opacity-70">{REASON_KIND_LABEL[r.kind]}</span>
                <span>{r.label}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-1.5">
          {track.previewUrl && (
            <PreviewPlayer
              previewUrl={track.previewUrl}
              source={previewSource(track)}
              itunesUrl={track.itunesUrl}
              label={`${track.artist} ${title}`}
            />
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {!track.previewUrl && (
              <button
                type="button"
                disabled={lookup !== 'idle'}
                onClick={async () => {
                  setLookup('loading');
                  const r = await fetchResolved(suggestion.track);
                  if (r?.previewUrl) setFound(r);
                  else setLookup('none');
                }}
                className="inline-flex items-center gap-1.5 text-[12px] text-[#8A8FA3] hover:text-[#E8E4DA] disabled:cursor-default disabled:hover:text-[#8A8FA3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D]"
              >
                <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
                  <path d="M5 3.5v9l7.5-4.5z" />
                </svg>
                {lookup === 'loading' ? 'Finding preview…' : lookup === 'none' ? 'No preview found' : 'Find a preview'}
              </button>
            )}
            {track.spotifyUrl && (
              <a
                href={track.spotifyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[12px] text-[#8A8FA3] underline-offset-2 hover:text-[#E8E4DA] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D]"
              >
                Open in Spotify
              </a>
            )}
            <a
              href={youtubeHref(track)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[12px] text-[#8A8FA3] underline-offset-2 hover:text-[#E8E4DA] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D]"
            >
              <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
                <path d="M15.3 4.6a2 2 0 0 0-1.4-1.4C12.7 3 8 3 8 3s-4.7 0-5.9.3A2 2 0 0 0 .7 4.6 21 21 0 0 0 .4 8c0 1.2.1 2.3.3 3.4a2 2 0 0 0 1.4 1.4C3.3 13 8 13 8 13s4.7 0 5.9-.3a2 2 0 0 0 1.4-1.4c.2-1.1.3-2.2.3-3.4s-.1-2.3-.3-3.4zM6.5 10.2V5.8L10.3 8z" />
              </svg>
              Watch on YouTube
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}
