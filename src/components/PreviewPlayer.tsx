'use client';

import type { SyntheticEvent } from 'react';
import type { PreviewSource } from './trackFormat';
import { safeHttpUrl } from './trackSanitize';

interface Props {
  previewUrl: string;
  source: PreviewSource;
  itunesUrl?: string;
  label: string;
}

/** Only one preview plays at a time across the page. */
function pauseOthers(e: SyntheticEvent<HTMLAudioElement>) {
  const self = e.currentTarget;
  document.querySelectorAll('audio').forEach((a) => {
    if (a !== self) a.pause();
  });
}

export default function PreviewPlayer({ previewUrl, source, itunesUrl, label }: Props) {
  const storeHref = safeHttpUrl(itunesUrl) ?? 'https://music.apple.com/search?term=' + encodeURIComponent(label);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <audio
          src={previewUrl}
          controls
          preload="none"
          onPlay={pauseOthers}
          aria-label={`30-second preview of ${label}`}
          className="h-8 min-w-0 flex-1 basis-48 [color-scheme:dark]"
        />
        {source === 'itunes' && (
          <a
            href={storeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[#E8E4DA]/25 bg-black px-2 py-1 text-[11px] leading-none text-[#E8E4DA] hover:border-[#E8E4DA]/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D]"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
              <path d="M11.2 1.5v8.3a2.3 2.3 0 1 1-1.2-2V4.1L6 5v6.3a2.3 2.3 0 1 1-1.2-2V3.1z" />
            </svg>
            Available on iTunes
          </a>
        )}
      </div>
      <span className="text-[11px] text-[#8A8FA3]/80">
        {source === 'itunes'
          ? 'Previews provided courtesy of iTunes'
          : source === 'deezer'
            ? 'Preview provided by Deezer'
            : '30-second preview'}
      </span>
    </div>
  );
}
