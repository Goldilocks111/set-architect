'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ArcTemplate, Suggestion, Track } from '@/types/track';
import { crateForRequest, isCrateComplete, type CrateTrack } from './crate';
import { EMPTY_CRATE_COPY } from './CratePanel';
import SuggestionCard from './SuggestionCard';
import { displayTitle } from './trackFormat';

interface Props {
  tracks: Track[];
  template: ArcTemplate;
  plannedLength: number;
  onAdd: (track: Track) => void;
  crate?: CrateTrack[];
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

export default function SuggestionBox({ tracks, template, plannedLength, onAdd, crate = NO_CRATE }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [limitMessage, setLimitMessage] = useState('');
  const [retry, setRetry] = useState(0);
  const [digging, setDigging] = useState(false);
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
  useLayoutEffect(() => {
    latestCrate.current = requestCrate;
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
        const body = (await res.json()) as { suggestions: Suggestion[]; digging?: boolean };
        setSuggestions(body.suggestions ?? []);
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

  return (
    <section aria-labelledby="suggestions-heading" className="flex flex-col">
      <header className="mb-1 flex items-baseline justify-between gap-3">
        <h2 id="suggestions-heading" className="font-[family-name:var(--font-display)] text-xl font-semibold text-[#E8E4DA]">
          {last ? 'Next up' : 'Openers'}
        </h2>
        {status === 'loading' && <span className="text-xs text-[#8A8FA3]">Scoring…</span>}
      </header>
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
          {readyCount === 0 ? EMPTY_CRATE_COPY : `${readyCount} crate track${readyCount === 1 ? ' is' : 's are'} ready to score. Import a Spotify playlist or a Mixed In Key CSV to suggest from more of your library.`}
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
