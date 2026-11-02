'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isComplete, RETRYABLE_REASONS, withDanceabilityPrior } from '@/lib/completeness';
import type { OverrideFields } from '@/lib/overrideValidation';
import { pairViolations, plannedTrackCount, setPlayedMinutes } from '@/engine';
import type { Track } from '@/types/track';
import ArcPicker from './ArcPicker';
import AutoOrderPanel from './AutoOrderPanel';
import BillingActions from './BillingActions';
import CratePanel from './CratePanel';
import { addToCrate, clearCrate, loadCrate, mergeCrateKnown, removeFromCrate, type CrateKnownItem, type CrateTrack } from './crate';
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
import { initialPlaylistState, playlistReducer, type LoadableState, type PlaylistAction } from './playlistReducer';
import { fetchResolved, needsMetadata } from './trackFormat';

/** Counted from enqueue: a track not answered by now is shown as incomplete ('timeout'); the server retries on its own. */
export const RESOLVE_CAP_MS = 60_000;
const MAX_IN_FLIGHT = 2;
/** Safety net so a hung request cannot hold a queue slot forever; the server answers within ~47 s. */
const HARD_ABORT_MS = 120_000;
/** A 'timeout' with no server retryAt (the client's own 60 s clock, or a request aborted before the server saw it). */
export const CLIENT_TIMEOUT_RETRY_MS = 5 * 60_000;
/** The server's own retry starts at retryAt and answers within its 45 s budget; re-asking after that is a cache hit. */
export const RETRY_SETTLE_MS = 50_000;
export const RETRY_JITTER_MS = 10_000;

interface Props {
  demo: boolean;
  getSongBpmConfigured: boolean;
}

export default function Builder({ demo, getSongBpmConfigured }: Props) {
  const [state, rawDispatch] = useReducer(playlistReducer, initialPlaylistState);
  // Mirrors the reducer synchronously, so the queue, retry timers and add() see the set as of the last action.
  const stateRef = useRef(initialPlaylistState);
  const dispatch = useCallback((action: PlaylistAction) => {
    stateRef.current = playlistReducer(stateRef.current, action);
    rawDispatch(action);
  }, []);
  const [hydrated, setHydrated] = useState(false);
  const [crate, setCrate] = useState<CrateTrack[]>([]);
  const [crateOpen, setCrateOpen] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const suggestRef = useRef<HTMLButtonElement>(null);
  const { tracks, arc, playFraction } = state;
  const plannedCount = plannedTrackCount(arc, playFraction);
  const inSet = useMemo(() => new Set(tracks.flatMap(recordingKeys)), [tracks]);

  // Bumped on unmount so late answers from a previous mount are dropped.
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const queue = useRef<Track[]>([]);
  const active = useRef(0);
  /** ids queued or in flight: never asked twice at once. */
  const pending = useRef(new Set<string>());
  /** At most one client re-ask timer per track; `key` is `${id}@${retryAt}` or `${id}@client`. */
  const retryTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; key: string }>());
  /** Keys whose re-ask already fired: a verdict repeating the same retryAt is not re-armed (no loop). */
  const firedRetries = useRef(new Set<string>());

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
  }, [dispatch]);

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
      pending.current.delete(track.id);
      const clock = clocks.current.get(track.id);
      clearTimeout(clock?.timer);
      clocks.current.delete(track.id);
      if (gen !== generation.current) return;
      if (resolved) dispatch({ type: 'resolved', id: track.id, track: resolved });
      else dispatch({ type: 'resolveFailed', id: track.id, reason: clock?.fired || ctrl.signal.aborted ? 'timeout' : 'providers-unavailable' });
    },
    [armClock, dispatch]
  );

  /** Every resolve request goes through here: at most MAX_IN_FLIGHT at once. */
  const pump = useCallback(
    function pump() {
      while (active.current < MAX_IN_FLIGHT && queue.current.length) {
        const next = queue.current.shift()!;
        if (!stateRef.current.tracks.some((t) => t.id === next.id)) {
          // removed from the set while queued: don't spend a request (or provider quota) on it
          pending.current.delete(next.id);
          clearTimeout(clocks.current.get(next.id)?.timer);
          clocks.current.delete(next.id);
          dispatch({ type: 'resolveFailed', id: next.id, reason: 'timeout' }); // drops it from `resolving`
          continue;
        }
        active.current++;
        const gen = generation.current;
        void startResolve(next).finally(() => {
          if (gen !== generation.current) return;
          active.current--;
          pump();
        });
      }
    },
    [startResolve, dispatch]
  );

  const requeue = useCallback(
    (list: Track[]) => {
      const fresh = list.filter((t) => !isComplete(t) && !pending.current.has(t.id));
      for (const t of fresh) {
        pending.current.add(t.id);
        dispatch({ type: 'resolveStart', id: t.id });
        armClock(t.id);
      }
      queue.current.push(...fresh);
      pump();
    },
    [pump, armClock, dispatch]
  );

  useEffect(() => {
    const gen = ++generation.current;
    setCrate(loadCrate());
    const stored = loadLocal();
    if (stored) {
      dispatch({ type: 'load', state: stored });
      // Only incomplete tracks are re-requested; complete ones are left alone.
      requeue(playlistReducer(initialPlaylistState, { type: 'load', state: stored }).tracks);
    }
    setHydrated(true);
    const live = controllers.current;
    const inFlightIds = pending.current;
    return () => {
      if (generation.current === gen) generation.current++;
      live.forEach((c) => c.abort());
      live.clear();
      clocks.current.forEach((c) => clearTimeout(c.timer));
      clocks.current.clear();
      queue.current = [];
      active.current = 0;
      inFlightIds.clear();
    };
  }, [requeue, dispatch]);

  // Retryable verdicts are re-asked once their retry is due, so the open tab picks up what the server's re-resolve
  // queue found ("retrying automatically" stays true). One timer per track; cleared on remove, completion or unmount.
  useEffect(() => {
    const timers = retryTimers.current;
    const due = new Map<string, { key: string; delay: number }>();
    for (const t of tracks) {
      const u = t.unresolved;
      if (!u || isComplete(t) || !RETRYABLE_REASONS.includes(u.reason) || pending.current.has(t.id)) continue;
      const jitter = Math.random() * RETRY_JITTER_MS;
      if (u.retryAt !== undefined) due.set(t.id, { key: `${t.id}@${u.retryAt}`, delay: Math.max(0, u.retryAt - Date.now()) + RETRY_SETTLE_MS + jitter });
      else if (u.reason === 'timeout') due.set(t.id, { key: `${t.id}@client`, delay: CLIENT_TIMEOUT_RETRY_MS + jitter });
    }
    for (const [id, armed] of timers) {
      if (due.get(id)?.key === armed.key) continue;
      clearTimeout(armed.timer);
      timers.delete(id);
    }
    for (const [id, { key, delay }] of due) {
      if (timers.has(id) || firedRetries.current.has(key)) continue;
      const timer = setTimeout(() => {
        timers.delete(id);
        firedRetries.current.add(key);
        const current = stateRef.current.tracks.find((t) => t.id === id);
        if (current) requeue([current]);
      }, delay);
      timers.set(id, { timer, key });
    }
  }, [tracks, state.resolving, requeue]);

  useEffect(() => {
    const timers = retryTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t.timer));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (hydrated) saveLocal(state);
  }, [state, hydrated]);

  // Everything that is in the set is also in the crate (with whatever the resolver has filled in by now).
  useEffect(() => {
    if (hydrated && tracks.length) setCrate(addToCrate(tracks, 'set'));
  }, [tracks, hydrated]);

  const crateKnown = useCallback((known: CrateKnownItem[]) => setCrate((cur) => mergeCrateKnown(known, cur)), []);

  const addCrate = useCallback((list: Track[], from: CrateTrack['from']) => setCrate(addToCrate(list, from)), []);

  const mikImported = useCallback(
    (rows: Array<{ artist: string; title: string; fields: OverrideFields }>) => {
      // Danceability is never in a MIK file: a row with energy gets the same prior the cache gives it.
      addCrate(
        rows.map((r, i) => withDanceabilityPrior({ id: `mik-${Date.now()}-${i}`, artist: r.artist, title: r.title, ...r.fields, sources: {} } as Track)),
        'mik'
      );
    },
    [addCrate]
  );

  const add = useCallback(
    (track: Track) => {
      const before = stateRef.current;
      dispatch({ type: 'add', track });
      if (stateRef.current === before) return; // already in the set: nothing to resolve
      // Search hits often lack BPM/key/energy/danceability; fill them in once the resolver answers. Through the
      // queue, so a Spotify "Add all" of 50 tracks never has more than MAX_IN_FLIGHT requests out at once.
      if (needsMetadata(track)) requeue([track]);
    },
    [dispatch, requeue]
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
  }, [dispatch]);

  /**
   * Mixed In Key values land as manual. Danceability is never in a MIK file: a row with energy is completed by the
   * danceability prior (reducer + server cache); anything still missing is asked of the resolver.
   */
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
    [state, requeue, dispatch]
  );

  const loadSet = useCallback(
    (p: LoadableState) => {
      dispatch({ type: 'load', state: p });
      requeue(playlistReducer(initialPlaylistState, { type: 'load', state: p }).tracks);
    },
    [requeue, dispatch]
  );
  // played minutes from real durations (estimates when missing) at the chosen play fraction
  const minutes = Math.round(setPlayedMinutes(tracks, playFraction));
  const rough = useMemo(() => pairViolations(tracks), [tracks]);
  const scrollToRough = () => {
    const first = rough[0] && tracks[rough[0].index];
    const el = document.getElementById(`transition-${first?.id}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#12141C] font-[family-name:var(--font-body)] text-[#E8E4DA]">
      {demo && <DemoBanner />}

      <header className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 pt-6 pb-4 sm:px-6">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h1 className="font-[family-name:var(--font-display)] text-[28px] leading-none font-semibold tracking-tight">Set Architect</h1>
          <p className="text-[13px] text-[#8A8FA3] tabular-nums" aria-live="polite">
            {tracks.length} of ~{plannedCount} tracks, about {minutes} min
          </p>
          {rough.length > 0 && (
            <button
              type="button"
              onClick={scrollToRough}
              className="rounded-md border border-[#EE8B7A]/50 px-2 py-0.5 text-[12px] text-[#EE8B7A] hover:bg-[#EE8B7A]/10 focus-visible:outline-2 focus-visible:outline-[#F2B33D]"
            >
              {rough.length} rough {rough.length === 1 ? 'transition' : 'transitions'}
            </button>
          )}
          {tracks.length >= 3 && (
            <button
              ref={suggestRef}
              type="button"
              onClick={() => setOrdering(true)}
              className="rounded-md border border-[#2A2F3F] px-2 py-0.5 text-[12px] text-[#E8E4DA] hover:border-[#8A8FA3] focus-visible:outline-2 focus-visible:outline-[#F2B33D]"
            >
              Suggest order
            </button>
          )}
          {state.orderUndo && (
            <button
              type="button"
              onClick={() => {
                dispatch({ type: 'undoOrder' });
                suggestRef.current?.focus(); // this button unmounts: hand focus to "Suggest order"
              }}
              className="rounded-md px-2 py-0.5 text-[12px] text-[#8A8FA3] underline underline-offset-2 hover:text-[#E8E4DA] focus-visible:outline-2 focus-visible:outline-[#F2B33D]"
            >
              Undo reorder
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <MikImport tracks={tracks} onApply={applyMik} onImported={mikImported} />
          <SpotifyConnect tracks={tracks} onAdd={add} onAddToCrate={(list) => addCrate(list, 'spotify')} />{/* spotify-connect */}
          {!demo && <BillingActions />}
          {!demo && (
            <SavedSets tracks={tracks} arc={arc} onLoad={loadSet} />
          )}
          <button
            type="button"
            onClick={() => setCrateOpen(true)}
            className="rounded-md border border-[#2A2F3F] px-3 py-1 text-[13px] text-[#E8E4DA] tabular-nums hover:border-[#8A8FA3] focus-visible:outline-2 focus-visible:outline-[#F2B33D]"
          >
            Crate: {crate.length} {crate.length === 1 ? 'track' : 'tracks'}
          </button>
          <ArcPicker
            value={arc}
            onChange={(a) => dispatch({ type: 'setArc', arc: a })}
            playFraction={playFraction}
            onPlayFractionChange={(f) => dispatch({ type: 'setPlayFraction', playFraction: f })}
          />
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
          <EnergyCurve tracks={tracks} arc={arc} playFraction={playFraction} />
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <section aria-labelledby="set-heading" className="flex min-w-0 flex-col gap-3">
            <h2 id="set-heading" className="font-[family-name:var(--font-display)] text-xl font-semibold">
              The set
            </h2>
            <SearchBar onAdd={add} inSet={inSet} />
            <SetList
              tracks={tracks}
              arc={arc}
              playFraction={playFraction}
              onRemove={(id) => dispatch({ type: 'remove', id })}
              onMove={(from, to) => dispatch({ type: 'reorder', from, to })}
              resolving={state.resolving}
              onOverride={override}
            />
          </section>

          <aside className="min-w-0 rounded-xl border border-[#2A2F3F] bg-[#1A1D28] px-4 pt-4 pb-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
            {hydrated && <SuggestionBox tracks={tracks} arc={arc} playFraction={playFraction} onAdd={add} busy={(state.resolving?.length ?? 0) > 0} crate={crate} onCrateKnown={crateKnown} />}
          </aside>
        </div>
      </main>

      {ordering && (
        <AutoOrderPanel
          tracks={tracks}
          arc={arc}
          playFraction={playFraction}
          onApply={(ids) => {
            dispatch({ type: 'applyOrder', ids });
            setOrdering(false);
          }}
          onCancel={() => setOrdering(false)}
          returnFocus={suggestRef}
        />
      )}

      {crateOpen && (
        <CratePanel
          crate={crate}
          onRemove={(id) => setCrate(removeFromCrate(id))}
          onClear={() => setCrate(clearCrate())}
          onClose={() => setCrateOpen(false)}
        />
      )}

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
