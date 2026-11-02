'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Arc, Track } from '@/types/track';

interface SavedPlaylist {
  id: string;
  name: string;
  arc: Arc;
  tracks: Track[];
}

interface Props {
  tracks: Track[];
  arc: Arc;
  onLoad: (p: { tracks: Track[]; arc: Arc }) => void;
}

/** Account-backed save/load; only rendered when Supabase is configured. */
export default function SavedSets({ tracks, arc, onLoad }: Props) {
  const [saved, setSaved] = useState<SavedPlaylist[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/playlists');
    const body = await res.json().catch(() => ({}));
    if (res.ok) setSaved(body.playlists ?? []);
    else if (res.status === 401) setMessage('Sign in to save sets to your account.');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const name = `Set ${new Date().toLocaleDateString()} (${tracks.length} tracks)`;
    const res = await fetch('/api/playlists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, arc, tracks }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setMessage('Saved to your account.');
      void refresh();
    } else {
      setMessage(body.error ?? 'Could not save the set.');
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <button
        type="button"
        onClick={save}
        disabled={busy || tracks.length === 0}
        className="rounded-md border border-[#2A2F3F] px-3 py-1 text-[#E8E4DA] hover:border-[#8A8FA3] disabled:opacity-40"
      >
        {busy ? 'Saving…' : 'Save set'}
      </button>
      {saved.length > 0 && (
        <select
          aria-label="Open a saved set"
          defaultValue=""
          onChange={(e) => {
            const p = saved.find((s) => s.id === e.target.value);
            if (p) onLoad({ tracks: p.tracks, arc: p.arc });
            e.target.value = '';
          }}
          className="rounded-md border border-[#2A2F3F] bg-[#12141C] px-2 py-1 text-[#E8E4DA]"
        >
          <option value="" disabled>
            Open saved set…
          </option>
          {saved.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {message && <span className="text-[#8A8FA3]">{message}</span>}
    </div>
  );
}
