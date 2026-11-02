'use client';

import type { CrateTrack } from './crate';
import { isCrateComplete } from './crate';

export const EMPTY_CRATE_COPY = 'Import a Spotify playlist or a Mixed In Key CSV to fill your crate \u2014 suggestions come from it first.';
/** Rows drawn at once; a 2000-track crate stays responsive and the rest is one scroll of "more" away. */
const SHOWN = 200;

interface Props {
  crate: CrateTrack[];
  onRemove: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
}

const FROM_LABEL: Record<CrateTrack['from'], string> = { set: 'set', spotify: 'Spotify', mik: 'Mixed In Key', search: 'search' };

/** The DJ's own pool: what suggestions are drawn from first. */
export default function CratePanel({ crate, onRemove, onClear, onClose }: Props) {
  const ready = crate.filter(isCrateComplete).length;
  const newest = [...crate].reverse();
  const btn = 'rounded-md px-2 py-1 text-[13px] focus-visible:outline-2 focus-visible:outline-[#F2B33D]';
  return (
    <div role="dialog" aria-label="Crate" className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16">
      <div className="flex max-h-[75vh] w-full max-w-[520px] flex-col gap-3 overflow-hidden rounded-lg border border-[#2A2E3D] bg-[#12141C] p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold">Your crate</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={crate.length === 0}
              onClick={() => {
                if (window.confirm(`Remove all ${crate.length} tracks from the crate?`)) onClear();
              }}
              className={`${btn} text-[#8A8FA3] hover:text-[#EE8B7A] disabled:opacity-30`}
            >
              Clear crate
            </button>
            <button type="button" aria-label="Close" onClick={onClose} className={`${btn} text-[#8A8FA3] hover:text-[#E8E4DA]`}>
              Close
            </button>
          </div>
        </div>

        {crate.length === 0 ? (
          <p className="text-[13px] text-[#8A8FA3]">{EMPTY_CRATE_COPY}</p>
        ) : (
          <>
            <p className="text-[12px] text-[#8A8FA3] tabular-nums">
              {ready} of {crate.length} ready to score. The rest join once their BPM, key and energy are known (add them to
              the set, or import a Mixed In Key CSV).
            </p>
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {newest.slice(0, SHOWN).map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-2 py-1.5">
                  <span className="min-w-0 text-[14px]">
                    <span className="block truncate">{c.title}</span>
                    <span className="block truncate text-[12px] text-[#8A8FA3]">
                      {c.artist} · {FROM_LABEL[c.from]}
                      {isCrateComplete(c) ? '' : ' · incomplete'}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${c.title} from crate`}
                    onClick={() => onRemove(c.id)}
                    className={`${btn} shrink-0 border border-[#2A2E3D] text-[#8A8FA3] hover:border-[#EE8B7A] hover:text-[#EE8B7A]`}
                  >
                    Remove
                  </button>
                </li>
              ))}
              {newest.length > SHOWN && (
                <li className="px-2 py-2 text-[12px] text-[#8A8FA3]">and {newest.length - SHOWN} more, oldest first to go</li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
