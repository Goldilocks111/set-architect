'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import { ARC_MAX_MINUTES, ARC_MIN_MINUTES, ARC_PRESETS, ARC_SHAPES, SHAPE_LABELS, toArc } from '@/lib/arc';
import type { Arc } from '@/types/track';

const PLAY_FRACTIONS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1];
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#F2B33D]';
const FIELD = `rounded-md border border-[#2A2F3F] bg-[#12141C] px-2 py-1 text-[13px] text-[#E8E4DA] ${FOCUS}`;

const presetLabel = (m: number) => (m < 60 ? `${m}m` : `${m / 60}h`);

interface Props {
  value: Arc;
  onChange: (arc: Arc) => void;
  playFraction: number;
  onPlayFractionChange: (f: number) => void;
}

/** Planned set length (presets or a custom 15-480 min), arc shape, and how much of each track is played. */
export default function ArcPicker({ value, onChange, playFraction, onPlayFractionChange }: Props) {
  const presetIndex = (ARC_PRESETS as readonly number[]).indexOf(value.minutes);
  /** The custom field while being typed in; null shows the current length. */
  const [draft, setDraft] = useState<string | null>(null);
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  const fractions = PLAY_FRACTIONS.includes(playFraction) ? PLAY_FRACTIONS : [...PLAY_FRACTIONS, playFraction].sort((a, b) => a - b);

  const pick = (i: number) => {
    const n = ARC_PRESETS.length;
    const at = ((i % n) + n) % n;
    onChange({ ...value, minutes: ARC_PRESETS[at] });
    radios.current[at]?.focus();
  };

  const onRadioKey = (e: KeyboardEvent, i: number) => {
    const moves: Record<string, number> = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: ARC_PRESETS.length - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    pick(moves[e.key]);
  };

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(n)) return; // reverts to the current length
    const next = toArc({ minutes: n, shape: value.shape });
    if (next.minutes !== value.minutes) onChange(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="radiogroup" aria-label="Set length" className="inline-flex rounded-lg border border-[#2A2F3F] p-0.5">
        {ARC_PRESETS.map((m, i) => {
          const selected = i === presetIndex;
          // roving tab stop: the checked preset, or the first one when a custom length is set
          const tabbable = selected || (presetIndex < 0 && i === 0);
          return (
            <button
              key={m}
              ref={(el) => {
                radios.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${m} min`}
              tabIndex={tabbable ? 0 : -1}
              onClick={() => pick(i)}
              onKeyDown={(e) => onRadioKey(e, i)}
              className={`rounded-md px-2.5 py-1 text-[13px] font-medium tabular-nums ${FOCUS} ${
                selected ? 'bg-[#E8E4DA] text-[#12141C]' : 'text-[#8A8FA3] hover:text-[#E8E4DA]'
              }`}
            >
              {presetLabel(m)}
            </button>
          );
        })}
      </div>
      <label className="flex items-center gap-1 text-[13px] text-[#8A8FA3]">
        <input
          type="number"
          inputMode="numeric"
          aria-label="Custom length in minutes"
          min={ARC_MIN_MINUTES}
          max={ARC_MAX_MINUTES}
          step={5}
          value={draft ?? String(value.minutes)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          className={`w-[4.5rem] tabular-nums ${FIELD} ${presetIndex < 0 ? 'border-[#E8E4DA]' : ''}`}
        />
        min
      </label>
      <select aria-label="Arc shape" value={value.shape} onChange={(e) => onChange(toArc({ ...value, shape: e.target.value }))} className={FIELD}>
        {ARC_SHAPES.map((s) => (
          <option key={s} value={s}>
            {SHAPE_LABELS[s][0].toUpperCase() + SHAPE_LABELS[s].slice(1)}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-[13px] text-[#8A8FA3]" title="How much of each track you play before mixing out">
        <select
          aria-label="Played per track"
          value={String(playFraction)}
          onChange={(e) => onPlayFractionChange(Number(e.target.value))}
          className={`tabular-nums ${FIELD}`}
        >
          {fractions.map((f) => (
            <option key={f} value={String(f)}>
              {Math.round(f * 100)}%
            </option>
          ))}
        </select>
        played
      </label>
    </div>
  );
}
