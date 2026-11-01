'use client';

import { useRef, useState } from 'react';
import { parseMikCsv, type MikRow } from '@/lib/mik';
import type { OverrideFields } from '@/lib/overrideValidation';
import { trackKeyOf, type Track } from '@/types/track';

/** Mirrors MAX_BATCH in the override route. */
const CHUNK = 2000;

interface Props {
  tracks: Track[];
  onApply: (updates: Array<{ id: string; fields: OverrideFields }>) => void;
}

const fieldsOf = (r: MikRow): OverrideFields => ({
  ...(r.bpm !== undefined ? { bpm: r.bpm } : {}),
  ...(r.camelot ? { camelot: r.camelot } : {}),
  ...(r.energy !== undefined ? { energy: r.energy } : {}),
});

function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/** Mixed In Key export: the DJ's own analysis beats our estimates, so these land as manual values. */
export default function MikImport({ tracks, onApply }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const run = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      const { rows, skipped } = parseMikCsv(await readText(file));
      if (rows.length === 0) {
        setMessage({ text: 'No usable rows found. Expected Artist, Title and a Key, BPM or Energy column.', error: true });
        return;
      }
      const applied: MikRow[] = [];
      let rejected = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const res = await fetch('/api/tracks/override', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: chunk.map((r) => ({ artist: r.artist, title: r.title, fields: fieldsOf(r) })) }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; rejected?: Array<{ index: number }> };
        if (!res.ok) {
          setMessage({ text: body.error ?? 'Could not import the file.', error: true });
          if (applied.length) break; // keep what earlier chunks already saved
          return;
        }
        const bad = new Set((body.rejected ?? []).map((r) => r.index));
        rejected += bad.size;
        chunk.forEach((r, j) => {
          if (!bad.has(j)) applied.push(r);
        });
      }
      const byKey = new Map<string, Track[]>();
      for (const t of tracks) {
        const k = trackKeyOf(t.artist, t.title);
        byKey.set(k, [...(byKey.get(k) ?? []), t]);
      }
      // later rows win on a repeated track, as on the server
      const merged = new Map<string, OverrideFields>();
      for (const r of applied) {
        const k = trackKeyOf(r.artist, r.title);
        if (byKey.has(k)) merged.set(k, { ...merged.get(k), ...fieldsOf(r) });
      }
      const updates = [...merged].flatMap(([k, fields]) => byKey.get(k)!.map((t) => ({ id: t.id, fields })));
      if (updates.length) onApply(updates);
      setMessage({ text: `Imported ${applied.length}, matched ${updates.length} in this set, skipped ${skipped + rejected}` });
    } catch {
      setMessage({ text: 'Could not read or import the file.', error: true });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        aria-label="Mixed In Key CSV file"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void run(f);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        title="Use your Mixed In Key key, BPM and energy values"
        className="rounded-md border border-[#2A2F3F] px-3 py-1 text-[13px] text-[#E8E4DA] hover:border-[#8A8FA3] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-[#F2B33D]"
      >
        {busy ? 'Importing…' : 'Import Mixed In Key CSV'}
      </button>
      {message && (
        <span role="status" className={`text-[12px] ${message.error ? 'text-[#EE8B7A]' : 'text-[#8A8FA3]'}`}>
          {message.text}
        </span>
      )}
    </div>
  );
}
