'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { autoOrder, pairViolations } from '@/engine';
import { DEFAULT_PLAY_FRACTION } from '@/lib/arc';
import { isComplete } from '@/lib/completeness';
import type { Arc, Track } from '@/types/track';
import { displayTitle, fmtBpm, fmtEnergy } from './trackFormat';

interface Props {
  tracks: Track[];
  arc: Arc;
  playFraction?: number;
  onApply: (ids: string[]) => void;
  onCancel: () => void;
  /** Gets focus back when the dialog closes (else whatever had focus when it opened; Safari doesn't focus clicked buttons). */
  returnFocus?: RefObject<HTMLElement | null>;
}

/** Fixed seed: the same set always gets the same proposal. */
const SEED = 1;

const rough = (n: number) => `${n} rough`;

/** Preview of a proposed set order: what moves and how many rough transitions it leaves, before anything changes. */
export default function AutoOrderPanel({ tracks, arc, playFraction = DEFAULT_PLAY_FRACTION, onApply, onCancel, returnFocus }: Props) {
  const [keepFirst, setKeepFirst] = useState(false);
  const [keepLast, setKeepLast] = useState(false);
  const before = useMemo(() => pairViolations(tracks).length, [tracks]);
  const result = useMemo(
    () => autoOrder(tracks, arc, { seed: SEED, keepFirst, keepLast, playFraction }),
    [tracks, arc, playFraction, keepFirst, keepLast]
  );
  const byId = useMemo(() => new Map(tracks.map((t, i) => [t.id, { t, i }])), [tracks]);
  const proposed = result.order.map((id) => byId.get(id)!);
  const moved = proposed.filter(({ i }, at) => i !== at).length;
  const incomplete = tracks.filter((t) => !isComplete(t)).length;
  const btn = 'rounded-md px-3 py-1 text-[13px] focus-visible:outline-2 focus-visible:outline-[#F2B33D]';
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);

  // Modal: focus moves in on open and back to whatever opened it ("Suggest order") on close, however it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const target = returnFocus;
    applyRef.current?.focus();
    return () => (target?.current ?? opener)?.focus?.();
  }, [returnFocus]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    // focus trap: Tab past the last control wraps to the first, Shift+Tab before the first wraps to the last
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inside = !!active && dialogRef.current.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16"
      onKeyDown={onKeyDown}
    >
      <div className="flex max-h-[80vh] w-full max-w-[560px] flex-col gap-3 overflow-hidden rounded-lg border border-[#2A2E3D] bg-[#12141C] p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id={titleId} className="font-[family-name:var(--font-display)] text-lg font-semibold">Suggested order</h2>
          <p className="text-[13px] tabular-nums">
            <span className={result.violations < before ? 'text-[#7DD3A8]' : result.violations ? 'text-[#EE8B7A]' : 'text-[#8A8FA3]'}>
              {`${rough(before)} → ${rough(result.violations)}`}
            </span>
          </p>
        </div>

        <p className="text-[12px] text-[#8A8FA3]" aria-live="polite">
          {moved === 0 ? 'Your current order is already the best one found.' : `${moved} of ${tracks.length} tracks move.`}
          {!result.feasible && (
            <span className="mt-1 block text-[#EE8B7A]">
              No order avoids every rough transition: this one has the fewest found ({result.violations}).
            </span>
          )}
          {incomplete > 0 && (
            <span className="mt-1 block">
              {incomplete} incomplete {incomplete === 1 ? 'track stays' : 'tracks stay'} at the end in their current order.
            </span>
          )}
        </p>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-[#C9CEDF]">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={keepFirst} onChange={(e) => setKeepFirst(e.target.checked)} className="accent-[#F2B33D]" />
            Keep first track
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={keepLast} onChange={(e) => setKeepLast(e.target.checked)} className="accent-[#F2B33D]" />
            Keep last track
          </label>
        </div>

        <ol aria-label="Proposed order" className="min-h-0 flex-1 overflow-y-auto">
          {proposed.map(({ t, i }, at) => {
            const isMoved = i !== at;
            return (
              <li
                key={t.id}
                data-track-id={t.id}
                data-moved={isMoved ? 'true' : undefined}
                className={`grid grid-cols-[28px_1fr_auto] items-center gap-x-3 rounded px-2 py-1.5 ${
                  isMoved ? 'border-l-2 border-[#F2B33D] bg-[#F2B33D]/5' : 'border-l-2 border-transparent'
                }`}
              >
                <span className="text-right font-[family-name:var(--font-display)] text-[15px] text-[#8A8FA3] tabular-nums">{at + 1}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px]">{displayTitle(t)}</span>
                  <span className="block truncate text-[12px] text-[#8A8FA3] tabular-nums">
                    {t.artist} · {t.camelot ?? 'key ?'} · {fmtBpm(t.bpm)} BPM · E{fmtEnergy(t.energy)}
                  </span>
                </span>
                <span className="text-[11.5px] text-[#F2B33D] tabular-nums">{isMoved ? `was #${i + 1}` : ''}</span>
              </li>
            );
          })}
        </ol>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={`${btn} text-[#8A8FA3] hover:text-[#E8E4DA]`}>
            Cancel
          </button>
          <button
            ref={applyRef}
            type="button"
            onClick={() => onApply(result.order)}
            className={`${btn} bg-[#F2B33D] font-semibold text-[#12141C] hover:bg-[#F2B33D]/90`}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
