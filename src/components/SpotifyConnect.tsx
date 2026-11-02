'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Track } from '@/types/track';
import SpotifyImport from './SpotifyImport';

interface Props {
  tracks: Track[];
  onAdd: (track: Track) => void;
  /** Adds playlist tracks to the crate without touching the set. */
  onAddToCrate?: (tracks: Track[]) => void;
}

/** Header control: "Connect Spotify" -> display name + menu (import playlist, save set, disconnect). */
export default function SpotifyConnect({ tracks, onAdd, onAddToCrate }: Props) {
  const [name, setName] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [menu, setMenu] = useState(false);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    url?: string;
    error?: boolean;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const body = (await (await fetch('/api/spotify/status')).json()) as {
        connected?: boolean;
        displayName?: string;
      };
      setName(body.connected ? (body.displayName ?? 'Spotify') : null);
    } catch {
      setName(null);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const q = new URLSearchParams(window.location.search).get('spotify');
    if (q === 'denied') setMessage({ text: 'Spotify connection was cancelled.', error: true });
    else if (q === 'error')
      setMessage({
        text: 'Could not connect to Spotify. Try again.',
        error: true,
      });
    if (q) window.history.replaceState(null, '', window.location.pathname);
  }, [refresh]);

  const exportable = tracks.filter((t) => t.spotifyId);
  const inSet = new Set(tracks.map((t) => t.id));

  const save = async () => {
    setMenu(false);
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/spotify/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Set Architect ${new Date().toISOString().slice(0, 10)}`,
          spotifyIds: exportable.map((t) => t.spotifyId),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (res.ok && body.url)
        setMessage({
          text: `Saved ${exportable.length} tracks.`,
          url: body.url,
        });
      else if (res.status === 401) {
        setName(null);
        setMessage({
          text: 'Spotify session expired. Reconnect.',
          error: true,
        });
      } else
        setMessage({
          text: body.error ?? 'Could not save to Spotify.',
          error: true,
        });
    } catch {
      setMessage({ text: 'Could not save to Spotify.', error: true });
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setMenu(false);
    await fetch('/api/spotify/session', { method: 'DELETE' }).catch(() => undefined);
    setName(null);
  };

  const btn = 'rounded-md px-2 py-1 text-[13px] focus-visible:outline-2 focus-visible:outline-[#1DB954]';
  const item =
    'block w-full rounded px-3 py-1.5 text-left text-[13px] hover:bg-[#232736] disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="relative flex items-center gap-2">
      {!checked ? null : name === null ? (
        <a href="/api/spotify/login" className={`${btn} bg-[#1DB954] font-medium text-[#12141C]`}>
          Connect Spotify
        </a>
      ) : (
        <>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={saving}
            onClick={() => setMenu((m) => !m)}
            className={`${btn} border border-[#1DB954] text-[#1DB954] disabled:opacity-50`}
          >
            {saving ? 'Saving…' : name}
          </button>
          {menu && (
            <div
              role="menu"
              className="absolute top-full right-0 z-40 mt-1 w-48 rounded-md border border-[#2A2E3D] bg-[#1B1E2A] p-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  setMenu(false);
                  setImporting(true);
                }}
              >
                Import playlist…
              </button>
              <button
                type="button"
                role="menuitem"
                className={item}
                disabled={exportable.length === 0}
                title={exportable.length === 0 ? 'No tracks with a Spotify ID in the set yet' : undefined}
                onClick={save}
              >
                Save set to Spotify
              </button>
              <button type="button" role="menuitem" className={item} onClick={disconnect}>
                Disconnect
              </button>
            </div>
          )}
        </>
      )}
      {message && (
        <span role="status" className={`text-[12px] ${message.error ? 'text-[#EE8B7A]' : 'text-[#8A8FA3]'}`}>
          {message.text}{' '}
          {message.url && (
            <a
              href={message.url}
              target="_blank"
              rel="noopener"
              className="text-[#1DB954] underline underline-offset-2"
            >
              Open
            </a>
          )}
        </span>
      )}
      {importing && (
        <SpotifyImport
          inSet={inSet}
          onAdd={onAdd}
          onAddToCrate={onAddToCrate}
          onClose={() => setImporting(false)}
          onDisconnected={() => {
            setImporting(false);
            setName(null);
          }}
        />
      )}
    </div>
  );
}
