'use client';

import type { Ref } from 'react';
import type { Suggestion } from '@/types/track';
import { displayTitle } from './trackFormat';

/** Seconds the owner gets to veto before radio adds the pick. */
export const RADIO_COUNTDOWN_S = 4;

/**
 * The suggestion radio chains next. The engine marks suggestions `compliant` (engine/compliance); that flag is
 * authoritative: the first `compliant === true`. When no suggestion carries it, fall back to the visible reasons:
 * the first suggestion with no key 'Clash', no '(clash)' BPM label and no 'Big energy jump'.
 */
export function radioPick(suggestions: Suggestion[]): Suggestion | undefined {
  if (suggestions.some((s) => s.compliant !== undefined)) return suggestions.find((s) => s.compliant === true);
  return suggestions.find(
    (s) =>
      !s.reasons.some(
        (r) =>
          (r.kind === 'key' && /clash/i.test(r.label)) ||
          (r.kind === 'bpm' && /\(clash\)/i.test(r.label)) ||
          (r.kind === 'energy' && r.label === 'Big energy jump')
      )
  );
}

interface Props {
  on: boolean;
  onToggle: () => void;
  /** Track about to be added and the seconds left, while a countdown runs. */
  pending?: { suggestion: Suggestion; seconds: number } | null;
  /** Why radio switched itself off, if it did. */
  note?: string;
  onCancel: () => void;
}

export default function RadioControl({ on, onToggle, toggleRef }: Pick<Props, 'on' | 'onToggle'> & { toggleRef?: Ref<HTMLButtonElement> }) {
  return (
      <button
        ref={toggleRef}
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Radio"
        onClick={onToggle}
        className={`rounded-full border px-3 py-0.5 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D] ${
          on ? 'border-[#F2B33D] bg-[#F2B33D] text-[#12141C]' : 'border-[#2A2F3F] text-[#8A8FA3] hover:text-[#E8E4DA]'
        }`}
      >
        Radio {on ? 'on' : 'off'}
      </button>
  );
}

/**
 * Under the header. The live region only changes when a pick starts (announced once, not every second);
 * the ticking countdown and Cancel sit beside it, hidden from the announcer.
 */
export function RadioStatus({ on, pending, note, onCancel }: Pick<Props, 'on' | 'pending' | 'note' | 'onCancel'>) {
  const counting = on && pending;
  return (
    <div className={on || note ? 'mb-2 text-xs text-[#8A8FA3]' : 'sr-only'}>
      <span role="status" aria-live="polite" className={counting ? 'sr-only' : undefined}>
        {counting ? `Adding ${displayTitle(pending.suggestion.track)} in ${RADIO_COUNTDOWN_S} seconds. Cancel is available.` : note}
      </span>
      {counting && (
        <>
          <span aria-hidden data-testid="radio-countdown">
            Adding <span className="text-[#E8E4DA]">{displayTitle(pending.suggestion.track)}</span> in {pending.seconds}…
          </span>{' '}
          <button
            type="button"
            onClick={onCancel}
            className="text-[#F2B33D] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D]"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
