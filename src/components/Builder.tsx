'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { Track } from '@/types/track';
import ArcTemplatePicker from './ArcTemplatePicker';
import BillingActions from './BillingActions';
import DemoBanner from './DemoBanner';
import EnergyCurve from './EnergyCurve';
import SavedSets from './SavedSets';
import SearchBar from './SearchBar';
import { recordingKeys } from './recordingKeys';
import SetList from './SetList';
import SpotifyConnect from './SpotifyConnect';
import SuggestionBox from './SuggestionBox';
import { loadLocal, saveLocal } from './persistence';
import { initialPlaylistState, plannedLengthFor, playlistReducer } from './playlistReducer';
import { fetchResolved, needsMetadata } from './trackFormat';

const MINUTES_PER_TRACK = 4;

interface Props {
  demo: boolean;
  getSongBpmConfigured: boolean;
}

export default function Builder({ demo, getSongBpmConfigured }: Props) {
  const [state, dispatch] = useReducer(playlistReducer, initialPlaylistState);
  const [hydrated, setHydrated] = useState(false);
  const { tracks, template } = state;
  const plannedLength = plannedLengthFor(template);
  const inSet = useMemo(() => new Set(tracks.flatMap(recordingKeys)), [tracks]);

  useEffect(() => {
    const stored = loadLocal();
    if (stored) dispatch({ type: 'load', state: stored });
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveLocal(state);
  }, [state, hydrated]);

  const add = useCallback(async (track: Track) => {
    dispatch({ type: 'add', track });
    if (!needsMetadata(track)) return;
    // Search hits often lack BPM/key/energy; fill them in once the resolver answers.
    const resolved = await fetchResolved(track);
    if (resolved) dispatch({ type: 'enrich', id: track.id, fields: resolved });
  }, []);
  const minutes = tracks.length * MINUTES_PER_TRACK;

  return (
    <div className="flex min-h-screen flex-col bg-[#12141C] font-[family-name:var(--font-body)] text-[#E8E4DA]">
      {demo && <DemoBanner />}

      <header className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 pt-6 pb-4 sm:px-6">
        <div className="flex items-baseline gap-4">
          <h1 className="font-[family-name:var(--font-display)] text-[28px] leading-none font-semibold tracking-tight">Set Architect</h1>
          <p className="text-[13px] text-[#8A8FA3] tabular-nums" aria-live="polite">
            {tracks.length} of {plannedLength} tracks, about {minutes} min
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SpotifyConnect tracks={tracks} onAdd={add} />{/* spotify-connect */}
          {!demo && <BillingActions />}
          {!demo && (
            <SavedSets tracks={tracks} template={template} onLoad={(p) => dispatch({ type: 'load', state: p })} />
          )}
          <ArcTemplatePicker value={template} onChange={(t) => dispatch({ type: 'setTemplate', template: t })} />
          <button
            type="button"
            disabled={tracks.length === 0}
            onClick={() => {
              if (window.confirm(`Clear all ${tracks.length} tracks from the set?`)) dispatch({ type: 'clear' });
            }}
            className="rounded-md px-2 py-1 text-[13px] text-[#8A8FA3] hover:text-[#EE8B7A] disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-[#F2B33D]"
          >
            Clear set
          </button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-6 px-4 pb-10 sm:px-6">
        <section aria-label="Energy curve" className="rounded-xl border border-[#2A2F3F] bg-[#1A1D28] px-3 pt-4 pb-3 sm:px-5">
          <EnergyCurve tracks={tracks} template={template} />
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <section aria-labelledby="set-heading" className="flex min-w-0 flex-col gap-3">
            <h2 id="set-heading" className="font-[family-name:var(--font-display)] text-xl font-semibold">
              The set
            </h2>
            <SearchBar onAdd={add} inSet={inSet} />
            <SetList
              tracks={tracks}
              template={template}
              plannedLength={plannedLength}
              onRemove={(id) => dispatch({ type: 'remove', id })}
              onMove={(from, to) => dispatch({ type: 'reorder', from, to })}
            />
          </section>

          <aside className="min-w-0 rounded-xl border border-[#2A2F3F] bg-[#1A1D28] px-4 pt-4 pb-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
            {hydrated && <SuggestionBox tracks={tracks} template={template} plannedLength={plannedLength} onAdd={add} />}
          </aside>
        </div>
      </main>

      <footer className="mx-auto flex w-full max-w-[1280px] flex-wrap gap-x-6 gap-y-1 border-t border-[#2A2F3F] px-4 py-4 text-[12px] text-[#8A8FA3] sm:px-6">
        <span>Previews provided courtesy of iTunes. Video links open YouTube.</span>
        {getSongBpmConfigured && (
          <a href="https://getsongbpm.com" target="_blank" rel="noopener" className="underline underline-offset-2 hover:text-[#E8E4DA]">
            BPM and key data by GetSongBPM
          </a>
        )}
      </footer>
    </div>
  );
}
