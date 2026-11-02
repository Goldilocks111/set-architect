'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ArcTemplate, Suggestion, Track } from '@/types/track';
import { crateForRequest, EMPTY_CRATE_COPY, isCrateComplete, type CrateKnownItem, type CrateTrack } from './crate';
import { isInSet, recordingKeys } from './recordingKeys';
import RadioControl, { RADIO_COUNTDOWN_S, radioPick, RadioStatus } from './RadioControl';
import SuggestionCard from './SuggestionCard';
import { displayTitle } from './trackFormat';

interface Props {
  tracks: Track[];
  template: ArcTemplate;
  plannedLength: number;
  onAdd: (track: Track) => void;
  crate?: CrateTrack[];
  /** What the server's cache knows about crate items; the owner folds it into the stored crate. */
  onCrateKnown?: (known: CrateKnownItem[]) => void;
  /** Tracks are still being resolved/queued: radio waits rather than adding in parallel. */
  busy?: boolean;
}

type Status = 'loading' | 'done' | 'error' | 'limit';

/** User actions (add/remove/reorder, template, retry) refresh promptly. */
const PROMPT_MS = 150;
/** Resolver answers only change a track's data: a burst of them (a set reload, "Add all") becomes one refresh. */
export const ENRICH_DEBOUNCE_MS = 1500;

/** What the server scores on; `unresolved`/resolving churn alone never changes it. */
const dataKeyOf = (tracks: Track[]) =>
  tracks.map((t) => [t.artist, t.title, t.bpm, t.camelot, t.energy, t.danceability].join('\u0001')).join('\n');

/** Fewer ready crate tracks than this and suggestions lean on neighbours/similar tracks: say how to fix that. */
export const CRATE_HINT_BELOW = 30;
const NO_CRATE: CrateTrack[] = [];

export default function SuggestionBox({ tracks, template, plannedLength, onAdd, crate = NO_CRATE, onCrateKnown, busy = false }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [limitMessage, setLimitMessage] = useState('');
  const [retry, setRetry] = useState(0);
  const [digging, setDigging] = useState(false);
  const [radio, setRadio] = useState(false);
  const [radioNote, setRadioNote] = useState('');
  const [countdown, setCountdown] = useState<{ suggestion: Suggestion; seconds: number } | null>(null);
  /** The set the current suggestions were computed for (ids), so radio never acts on a stale list. */
  const [suggestedFor, setSuggestedFor] = useState('');
  const sectionRef = useRef<HTMLElement>(null);
  const proposed = useRef(new Set<string>());
  const radioAdded = useRef<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(watchdog.current), []);
  const prevShape = useRef('');
  const last = tracks[tracks.length - 1];
  const lastKey = last ? `${last.artist}|${last.title}` : '';
  const refetched = useRef(new Set<string>());
  const latest = useRef(tracks);
  useLayoutEffect(() => {
    latest.current = tracks;
  });
  const shapeKey = tracks.map((t) => t.id).join('\n');
  const dataKey = dataKeyOf(tracks);
  const lastTrigger = useRef<string | null>(null);
  const requestCrate = useMemo(() => crateForRequest(crate, tracks), [crate, tracks]);
  const readyCount = useMemo(() => requestCrate.filter(isCrateComplete).length, [requestCrate]);
  const latestCrate = useRef(requestCrate);
  const knownHandler = useRef(onCrateKnown);
  useLayoutEffect(() => {
    latestCrate.current = requestCrate;
    knownHandler.current = onCrateKnown;
  });
  // What the server can score from the crate; a refresh follows an import, not every re-sort or set add.
  const crateKey = useMemo(() => requestCrate.map((c) => `${c.id}${isCrateComplete(c) ? '+' : '-'}`).sort().join('\n'), [requestCrate]);

  useEffect(() => {
    const ctrl = new AbortController();
    let refetchTimer: ReturnType<typeof setTimeout> | undefined;
    const trigger = JSON.stringify([shapeKey, template, plannedLength, retry]);
    // recorded when the request fires, so a cancelled run (StrictMode, a quick follow-up change) stays prompt
    const prompt = lastTrigger.current !== trigger;
    const timer = setTimeout(async () => {
      lastTrigger.current = trigger;
      setStatus('loading');
      try {
        const res = await fetch('/api/suggest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ playlist: latest.current, template, plannedLength, crate: latestCrate.current }),
          signal: ctrl.signal,
        });
        if (res.status === 429) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setLimitMessage(body.error ?? 'Daily suggestion limit reached. Upgrade for unlimited suggestions.');
          setSuggestions([]);
          setStatus('limit');
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { suggestions: Suggestion[]; digging?: boolean; crateKnown?: CrateKnownItem[] };
        if (body.crateKnown?.length) knownHandler.current?.(body.crateKnown);
        setSuggestions(body.suggestions ?? []);
        setSuggestedFor(latest.current.map((x) => x.id).join('\n'));
        setStatus('done');
        setDigging(body.digging === true);
        // One re-fetch after ingestion has had time to land; the key changes with the track so it never loops.
        if (body.digging && !refetched.current.has(lastKey)) {
          refetched.current.add(lastKey);
          refetchTimer = setTimeout(() => setRetry((r) => r + 1), 8000);
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setStatus('error');
      }
    }, prompt ? PROMPT_MS : ENRICH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      clearTimeout(refetchTimer);
      ctrl.abort();
    };
  }, [shapeKey, dataKey, crateKey, template, plannedLength, retry, lastKey]);

  const stopRadio = useCallback((why = '') => {
    clearTimeout(watchdog.current);
    setRadio(false);
    setCountdown(null);
    setRadioNote(why);
  }, []);
  const toggleRadio = () => {
    if (radio) return stopRadio();
    proposed.current = new Set();
    radioAdded.current = null;
    setRadioNote('');
    setRadio(true);
  };

  // Any change to the set that radio did not make itself is the owner steering: hand back control.
  useEffect(() => {
    const before = prevShape.current;
    prevShape.current = shapeKey;
    if (!radio || before === shapeKey) return;
    const own = radioAdded.current !== null && shapeKey === `${before}\n${radioAdded.current}`.replace(/^\n/, '');
    radioAdded.current = null;
    if (own) clearTimeout(watchdog.current);
    if (!own) stopRadio('Radio stopped: the set changed.');
  }, [shapeKey, radio, stopRadio]);

  // Focusing or typing in the search box means the owner is steering. (Clicks elsewhere, previews, scrolling don't.)
  useEffect(() => {
    if (!radio) return;
    const onSearch = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('[role="combobox"]') && !sectionRef.current?.contains(el)) stopRadio('Radio stopped: you took over.');
    };
    document.addEventListener('focusin', onSearch, true);
    document.addEventListener('keydown', onSearch, true);
    return () => {
      document.removeEventListener('focusin', onSearch, true);
      document.removeEventListener('keydown', onSearch, true);
    };
  }, [radio, stopRadio]);

  // Radio: once suggestions are fresh for the current set and nothing is in flight, count down, then add the pick.
  // a recording already in the set (under another id) would make add() a no-op: skip it
  const pick = useMemo(() => {
    const inSet = new Set(latest.current.flatMap(recordingKeys));
    return radioPick(suggestions.filter((s) => !isInSet(inSet, s.track)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions, shapeKey]);
  const fresh = status === 'done' && suggestedFor === shapeKey;
  const pickId = pick?.track.id;
  useEffect(() => {
    if (!radio) return;
    if (tracks.length >= plannedLength) return stopRadio('Radio stopped: the set is full.');
    if (status === 'error' || status === 'limit') return stopRadio('Radio stopped: suggestions failed.');
    if (!fresh || busy) return;
    if (!pick) return stopRadio('Radio stopped: no compliant suggestion.');
    if (proposed.current.has(pick.track.id) || tracks.some((x) => x.id === pick.track.id))
      return stopRadio('Radio stopped: the same track was proposed twice.');
    let left = RADIO_COUNTDOWN_S;
    setCountdown({ suggestion: pick, seconds: left });
    const timer = setInterval(() => {
      left -= 1;
      if (left > 0) return setCountdown({ suggestion: pick, seconds: left });
      clearInterval(timer);
      setCountdown(null);
      proposed.current.add(pick.track.id);
      radioAdded.current = pick.track.id;
      const before = latest.current.length;
      onAdd(pick.track);
      // add() ignores a recording the set already has: don't sit "on" silently
      clearTimeout(watchdog.current);
      watchdog.current = setTimeout(() => {
        if (latest.current.length <= before) stopRadio(`Radio stopped — couldn't add ${displayTitle(pick.track)}`);
      }, 2000);
    }, 1000);
    return () => {
      clearInterval(timer);
      setCountdown(null);
    };
    // pick is identified by its id: a same-top refresh must not restart the countdown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radio, fresh, busy, pickId, status, tracks.length, plannedLength]);

  return (
    <section ref={sectionRef} aria-labelledby="suggestions-heading" className="flex flex-col">
      <header className="mb-1 flex items-baseline justify-between gap-3">
        <h2 id="suggestions-heading" className="font-[family-name:var(--font-display)] text-xl font-semibold text-[#E8E4DA]">
          {last ? 'Next up' : 'Openers'}
        </h2>
        <span className="flex items-baseline gap-2">
          {status === 'loading' && <span className="text-xs text-[#8A8FA3]">Scoring…</span>}
          <RadioControl on={radio} onToggle={toggleRadio} toggleRef={toggleRef} />
        </span>
      </header>
      <RadioStatus on={radio} pending={countdown} note={radioNote} onCancel={() => {
          stopRadio('Radio cancelled.');
          toggleRef.current?.focus();
        }} />
      {digging && (
        <p className="mb-1 text-xs italic text-[#8A8FA3]">
          Digging through real DJ sets… suggestions improve as sets are indexed
        </p>
      )}
      <p className="mb-2 text-[13px] text-[#8A8FA3]">
        {last ? (
          <>
            Tracks that mix out of <span className="text-[#E8E4DA]">{displayTitle(last)}</span> and keep you on the arc.
          </>
        ) : (
          'Tracks that fit the start of the arc. Pick one to open your set.'
        )}
      </p>

      {readyCount < CRATE_HINT_BELOW && (
        <p className="mb-2 text-xs text-[#8A8FA3]">
          {readyCount === 0 && requestCrate.length === 0
            ? `${EMPTY_CRATE_COPY} Until then a starter crate fills in.`
            : `Imported tracks get analysed a few at a time as you build — ${readyCount} of ${requestCrate.length} ready.`}
        </p>
      )}

      {status === 'limit' && (
        <div role="alert" className="rounded-lg border border-[#F2B33D]/40 px-4 py-3 text-sm text-[#F2B33D]">
          {limitMessage}
        </div>
      )}
      {status === 'error' && (
        <div className="rounded-lg border border-[#EE8B7A]/30 px-4 py-3 text-sm text-[#EE8B7A]">
          Couldn&apos;t load suggestions.{' '}
          <button type="button" onClick={() => setRetry((r) => r + 1)} className="underline underline-offset-2">
            Try again
          </button>
        </div>
      )}
      {status === 'done' && suggestions.length === 0 && (
        <p className="rounded-lg border border-dashed border-[#2A2F3F] px-4 py-6 text-center text-sm text-[#8A8FA3]">
          Nothing compatible left in the crate. Search for a track to change direction.
        </p>
      )}
      <div className={status === 'loading' ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        {suggestions.map((s) => (
          <SuggestionCard key={s.track.id} suggestion={s} onAdd={onAdd} />
        ))}
      </div>
    </section>
  );
}
