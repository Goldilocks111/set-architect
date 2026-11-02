'use client';

import type { Suggestion } from '@/types/track';
import { displayTitle } from './trackFormat';

/** Seconds the owner gets to veto before radio adds the pick. */
export const RADIO_COUNTDOWN_S = 4;

/**
 * The suggestion radio chains next. Once the engine marks suggestions `compliant` (Phase 3 Task 4) that flag is
 * authoritative: the first `compliant === true`. Until a suggestion carries it, fall back to the visible reasons:
 * the first suggestion with no key 'Clash', no '(clash)' BPM label and no 'Big energy jump'.
 */
export function radioPick(suggestions: Suggestion[]): Suggestion | undefined {
  const flag = (s: Suggestion) => (s as Suggestion & { compliant?: boolean }).compliant;
  if (suggestions.some((s) => flag(s) !== undefined)) return suggestions.find((s) => flag(s) === true);
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

export default function RadioControl({ on, onToggle }: Pick<Props, 'on' | 'onToggle'>) {
  return (
      <button
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

/** The polite live region under the header: countdown with Cancel, or why radio stopped. */
export function RadioStatus({ on, pending, note, onCancel }: Pick<Props, 'on' | 'pending' | 'note' | 'onCancel'>) {
  return (
    <div role="status" aria-live="polite" className={on || note ? 'mb-2 text-xs text-[#8A8FA3]' : 'sr-only'}>
      {on && pending && (
        <>
          Adding <span className="text-[#E8E4DA]">{displayTitle(pending.suggestion.track)}</span> in {pending.seconds}…{' '}
          <button
            type="button"
            onClick={onCancel}
            className="text-[#F2B33D] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D]"
          >
            Cancel
          </button>
        </>
      )}
      {!(on && pending) && note}
    </div>
  );
}
