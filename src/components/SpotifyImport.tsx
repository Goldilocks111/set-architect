'use client';

import { useEffect, useState } from 'react';
import type { Track } from '@/types/track';

interface Playlist {
  id: string;
  name: string;
  trackCount: number;
}
interface PlaylistTrack {
  artist: string;
  title: string;
  spotifyId: string;
  spotifyUrl?: string;
  popularity?: number;
}

interface Props {
  inSet: Set<string>;
  onAdd: (track: Track) => void;
  onClose: () => void;
  onDisconnected: () => void;
}

export const toTrack = (t: PlaylistTrack): Track => ({
  id: `spotify-${t.spotifyId}`,
  artist: t.artist,
  title: t.title,
  spotifyId: t.spotifyId,
  spotifyUrl: t.spotifyUrl,
  popularity: t.popularity,
  sources: {
    spotifyId: 'spotify',
    ...(t.popularity !== undefined ? { popularity: 'spotify' } : {}),
  },
});

/** Picker panel: choose one of the user's playlists, then add tracks individually or all at once. */
export default function SpotifyImport({ inSet, onAdd, onClose, onDisconnected }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [picked, setPicked] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async <T,>(url: string): Promise<T | null> => {
    setError(null);
    try {
      const res = await fetch(url);
      if (res.status === 401) {
        onDisconnected();
        return null;
      }
      const body = (await res.json().catch(() => ({}))) as T & {
        error?: string;
      };
      if (!res.ok) {
        setError(body.error ?? 'Could not reach Spotify.');
        return null;
      }
      return body;
    } catch {
      setError('Could not reach Spotify.');
      return null;
    }
  };

  useEffect(() => {
    let live = true;
    load<{ playlists: Playlist[] }>('/api/spotify/playlists').then((b) => live && b && setPlaylists(b.playlists));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (p: Playlist) => {
    setPicked(p);
    setTracks(null);
    const b = await load<{ tracks: PlaylistTrack[] }>(`/api/spotify/playlists/${encodeURIComponent(p.id)}/tracks`);
    setTracks(b?.tracks ?? []);
  };

  const addable = (tracks ?? []).filter((t) => !inSet.has(`spotify-${t.spotifyId}`));
  const btn = 'rounded-md px-2 py-1 text-[13px] focus-visible:outline-2 focus-visible:outline-[#1DB954]';

  return (
    <div
      role="dialog"
      aria-label="Import from Spotify"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16"
    >
      <div className="flex max-h-[75vh] w-full max-w-[520px] flex-col gap-3 overflow-hidden rounded-lg border border-[#2A2E3D] bg-[#12141C] p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold">
            {picked ? picked.name : 'Import a Spotify playlist'}
          </h2>
          <div className="flex items-center gap-2">
            {picked && (
              <button
                type="button"
                className={`${btn} text-[#8A8FA3] hover:text-[#E8E4DA]`}
                onClick={() => setPicked(null)}
              >
                Back
              </button>
            )}
            <button
              type="button"
              aria-label="Close"
              className={`${btn} text-[#8A8FA3] hover:text-[#E8E4DA]`}
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-[12px] text-[#EE8B7A]">
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!picked && (
            <>
              {!playlists && !error && <p className="text-[13px] text-[#8A8FA3]">Loading playlists…</p>}
              {playlists?.length === 0 && <p className="text-[13px] text-[#8A8FA3]">No playlists found.</p>}
              <ul className="flex flex-col">
                {playlists?.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => pick(p)}
                      className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-[14px] hover:bg-[#1B1E2A] focus-visible:outline-2 focus-visible:outline-[#1DB954]"
                    >
                      <span className="truncate">{p.name}</span>
                      <span className="ml-3 shrink-0 text-[12px] text-[#8A8FA3] tabular-nums">{p.trackCount}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {picked && (
            <>
              {!tracks && !error && <p className="text-[13px] text-[#8A8FA3]">Loading tracks…</p>}
              {tracks?.length === 0 && (
                <p className="text-[13px] text-[#8A8FA3]">No importable tracks in this playlist.</p>
              )}
              <ul className="flex flex-col">
                {tracks?.map((t) => {
                  const already = inSet.has(`spotify-${t.spotifyId}`);
                  return (
                    <li key={t.spotifyId} className="flex items-center justify-between gap-3 px-2 py-1.5">
                      <span className="min-w-0 text-[14px]">
                        <span className="block truncate">{t.title}</span>
                        <span className="block truncate text-[12px] text-[#8A8FA3]">{t.artist}</span>
                      </span>
                      <button
                        type="button"
                        disabled={already}
                        aria-label={`Add ${t.title}`}
                        onClick={() => onAdd(toTrack(t))}
                        className={`${btn} shrink-0 border border-[#2A2E3D] hover:border-[#1DB954] disabled:opacity-40`}
                      >
                        {already ? 'Added' : 'Add'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {picked && tracks && tracks.length > 0 && (
          <button
            type="button"
            disabled={addable.length === 0}
            onClick={() => addable.forEach((t) => onAdd(toTrack(t)))}
            className={`${btn} bg-[#1DB954] font-medium text-[#12141C] disabled:opacity-50`}
          >
            {addable.length === 0 ? 'All tracks added' : `Add all (${addable.length})`}
          </button>
        )}
      </div>
    </div>
  );
}
