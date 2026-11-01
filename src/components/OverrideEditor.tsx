'use client';

import { useId, useState } from 'react';
import { validateOverride, type OverrideFields } from '@/lib/overrideValidation';
import type { Track } from '@/types/track';

interface Props {
  track: Track;
  /** Resolves to an error message, or null when saved. */
  onSave: (fields: OverrideFields) => Promise<string | null>;
  onCancel: () => void;
}

const FIELDS = [
  { key: 'bpm', label: 'BPM', step: '0.1', hint: '60–200' },
  { key: 'camelot', label: 'Key', step: undefined, hint: 'e.g. 8A' },
  { key: 'energy', label: 'Energy', step: '1', hint: '1–10' },
  { key: 'danceability', label: 'Danceability', step: '0.01', hint: '0–1' },
] as const;

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D]';
const input =
  'w-20 rounded border border-[#2A2F3F] bg-[#12141C] px-1.5 py-1 text-[12.5px] text-[#E8E4DA] tabular-nums focus-visible:outline-2 focus-visible:outline-[#F2B33D]';

export default function OverrideEditor({ track, onSave, onCancel }: Props) {
  const uid = useId();
  const [initial] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, track[f.key] === undefined ? '' : String(track[f.key])]))
  );
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const raw: Record<string, unknown> = {};
    for (const f of FIELDS) {
      // Only what the user changed: untouched provider values keep their source and are not re-validated.
      const v = values[f.key].trim();
      if (v === '' || v === initial[f.key].trim()) continue;
      raw[f.key] = f.key === 'camelot' ? v : Number(v);
    }
    const checked = validateOverride(raw);
    if (!checked.ok) return setError(checked.error);
    setBusy(true);
    const err = await onSave(checked.fields);
    setBusy(false);
    if (err) setError(err);
  }

  return (
    <form
      className="col-span-full mt-2 flex flex-wrap items-end gap-x-3 gap-y-2 rounded-md border border-[#2A2F3F] bg-[#1A1D28] p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onDragStart={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      {FIELDS.map((f) => (
        <div key={f.key} className="flex flex-col gap-0.5 text-[11.5px] text-[#8A8FA3]">
          <label htmlFor={`${uid}-${f.key}`}>{f.label}</label>
          <input
            id={`${uid}-${f.key}`}
            autoFocus={f.key === 'bpm'}
            aria-describedby={`${uid}-${f.key}-hint`}
            className={input}
            value={values[f.key]}
            inputMode={f.key === 'camelot' ? 'text' : 'decimal'}
            placeholder={f.hint}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
          <span id={`${uid}-${f.key}-hint`} className="text-[10.5px] text-[#8A8FA3]/70">{f.hint}</span>
        </div>
      ))}
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-[#F2B33D] px-2.5 py-1 text-[12.5px] font-medium text-[#12141C] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D]"
      >
        Save
      </button>
      <button type="button" onClick={onCancel} className={`rounded px-1.5 py-1 text-[12.5px] text-[#8A8FA3] hover:text-[#E8E4DA] ${focusRing}`}>
        Cancel
      </button>
      {error && (
        <p role="alert" className="basis-full text-[12px] text-[#EE8B7A]">
          {error}
        </p>
      )}
    </form>
  );
}
