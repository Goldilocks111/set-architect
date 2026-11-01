'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isComplete } from '@/lib/completeness';
import type { OverrideFields } from '@/lib/overrideValidation';
import type { Track } from '@/types/track';
import ArcTemplatePicker from './ArcTemplatePicker';
import BillingActions from './BillingActions';
import DemoBanner from './DemoBanner';
import EnergyCurve from './EnergyCurve';
import MikImport from './MikImport';
import SavedSets from './SavedSets';
import SearchBar from './SearchBar';
import { recordingKeys } from './recordingKeys';
import SetList from './SetList';
import SpotifyConnect from './SpotifyConnect';
import SuggestionBox from './SuggestionBox';
import { loadLocal, saveLocal } from './persistence';
import { initialPlaylistState, plannedLengthFor, playlistReducer, type PlaylistState } from './playlistReducer';
import { fetchResolved, needsMetadata } from './trackFormat';

const MINUTES_PER_TRACK = 4;
/** Counted from enqueue: a track not answered by now is shown as incomplete ('timeout'); the server retries on its own. */
export const RESOLVE_CAP_MS = 60_000;
const MAX_IN_FLIGHT = 2;
/** Safety net so a hung request cannot hold a queue slot forever; the server answers within ~47 s. */
const HARD_ABORT_MS = 120_000;

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

  // Bumped on unmount so late answers from a previous mount are dropped.
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const queue = useRef<Track[]>([]);
  const active = useRef(0);

  // The 60 s clock starts when a track is first asked for (enqueue or direct add), not when its request starts.
  const clocks = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; fired: boolean }>());

  const armClock = useCallback((id: string) => {
    if (clocks.current.has(id)) return;
    const gen = generation.current;
    const clock = {
      fired: false,
      timer: setTimeout(() => {
        clock.fired = true;
        if (gen === generation.current) dispatch({ type: 'resolveFailed', id, reason: 'timeout' });
      }, RESOLVE_CAP_MS),
    };
    clocks.current.set(id, clock);
  }, []);

  const startResolve = useCallback(
    async (track: Track) => {
      const gen = generation.current;
      // A track whose clock already fired stays incomplete/'timeout' while its request runs.
      if (!clocks.current.get(track.id)?.fired) dispatch({ type: 'resolveStart', id: track.id });
      armClock(track.id);
      const ctrl = new AbortController();
      controllers.current.add(ctrl);
      // The request outlives the displayed cap (a late answer still applies); this only frees a hung slot.
      const hard = setTimeout(() => ctrl.abort(), HARD_ABORT_MS);
      const resolved = await fetchResolved(track, ctrl.signal);
      clearTimeout(hard);
      controllers.current.delete(ctrl);
      const clock = clocks.current.get(track.id);
      clearTimeout(clock?.timer);
      clocks.current.delete(track.id);
      if (gen !== generation.current) return;
      if (resolved) dispatch({ type: 'resolved', id: track.id, track: resolved });
      else dispatch({ type: 'resolveFailed', id: track.id, reason: clock?.fired || ctrl.signal.aborted ? 'timeout' : 'providers-unavailable' });
    },
    [armClock]
  );

  /** Background re-requests run sequentially-ish: at most MAX_IN_FLIGHT at once. */
  const pump = useCallback(
    function pump() {
      while (active.current < MAX_IN_FLIGHT && queue.current.length) {
        const next = queue.current.shift()!;
        active.current++;
        const gen = generation.current;
        void startResolve(next).finally(() => {
          if (gen !== generation.current) return;
          active.current--;
          pump();
        });
      }
    },
    [startResolve]
  );

  const requeue = useCallback(
    (list: Track[]) => {
      const pending = list.filter((t) => !isComplete(t));
      for (const t of pending) {
        dispatch({ type: 'resolveStart', id: t.id });
        armClock(t.id);
      }
      queue.current.push(...pending);
      pump();
    },
    [pump, armClock]
  );

  useEffect(() => {
    const gen = ++generation.current;
    const stored = loadLocal();
    if (stored) {
      dispatch({ type: 'load', state: stored });
      // Only incomplete tracks are re-requested; complete ones are left alone.
      requeue(playlistReducer(initialPlaylistState, { type: 'load', state: stored }).tracks);
    }
    setHydrated(true);
    const live = controllers.current;
    return () => {
      if (generation.current === gen) generation.current++;
      live.forEach((c) => c.abort());
      live.clear();
      clocks.current.forEach((c) => clearTimeout(c.timer));
      clocks.current.clear();
      queue.current = [];
      active.current = 0;
    };
  }, [requeue]);

  useEffect(() => {
    if (hydrated) saveLocal(state);
  }, [state, hydrated]);

  const add = useCallback(
    async (track: Track) => {
      dispatch({ type: 'add', track });
      // Search hits often lack BPM/key/energy/danceability; fill them in once the resolver answers.
      if (needsMetadata(track)) await startResolve(track);
    },
    [startResolve]
  );

  const override = useCallback(async (track: Track, fields: OverrideFields): Promise<string | null> => {
    try {
      const res = await fetch('/api/tracks/override', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artist: track.artist, title: track.title, fields }),
      });
      if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not save these values';
    } catch {
      return 'Could not reach the server';
    }
    dispatch({ type: 'override', id: track.id, fields });
    return null;
  }, []);

  /** Mixed In Key values land as manual; danceability is never in a MIK file, so the resolver is asked for it. */
  const applyMik = useCallback(
    (updates: Array<{ id: string; fields: OverrideFields }>) => {
      let next = state;
      for (const u of updates) {
        dispatch({ type: 'override', id: u.id, fields: u.fields });
        next = playlistReducer(next, { type: 'override', id: u.id, fields: u.fields });
      }
      const ids = new Set(updates.map((u) => u.id));
      requeue(next.tracks.filter((t) => ids.has(t.id)));
    },
    [state, requeue]
  );

  const loadSet = useCallback(
    (p: PlaylistState) => {
      dispatch({ type: 'load', state: p });
      requeue(playlistReducer(initialPlaylistState, { type: 'load', state: p }).tracks);
    },
    [requeue]
  );
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
          <MikImport tracks={tracks} onApply={applyMik} />
          <SpotifyConnect tracks={tracks} onAdd={add} />{/* spotify-connect */}
          {!demo && <BillingActions />}
          {!demo && (
            <SavedSets tracks={tracks} template={template} onLoad={loadSet} />
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
              resolving={state.resolving}
              onOverride={override}
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
