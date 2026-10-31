'use client';

import { useEffect, useState } from 'react';
import type { ArcTemplate, Suggestion, Track } from '@/types/track';
import SuggestionCard from './SuggestionCard';
import { displayTitle } from './trackFormat';

interface Props {
  tracks: Track[];
  template: ArcTemplate;
  plannedLength: number;
  onAdd: (track: Track) => void;
}

type Status = 'loading' | 'done' | 'error' | 'limit';

export default function SuggestionBox({ tracks, template, plannedLength, onAdd }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [limitMessage, setLimitMessage] = useState('');
  const [retry, setRetry] = useState(0);
  const last = tracks[tracks.length - 1];

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setStatus('loading');
      try {
        const res = await fetch('/api/suggest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ playlist: tracks, template, plannedLength }),
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
        const body = (await res.json()) as { suggestions: Suggestion[] };
        setSuggestions(body.suggestions ?? []);
        setStatus('done');
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setStatus('error');
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [tracks, template, plannedLength, retry]);

  return (
    <section aria-labelledby="suggestions-heading" className="flex flex-col">
      <header className="mb-1 flex items-baseline justify-between gap-3">
        <h2 id="suggestions-heading" className="font-[family-name:var(--font-display)] text-xl font-semibold text-[#E8E4DA]">
          {last ? 'Next up' : 'Openers'}
        </h2>
        {status === 'loading' && <span className="text-xs text-[#8A8FA3]">Scoring…</span>}
      </header>
      <p className="mb-2 text-[13px] text-[#8A8FA3]">
        {last ? (
          <>
            Tracks that mix out of <span className="text-[#E8E4DA]">{displayTitle(last)}</span> and keep you on the arc.
          </>
        ) : (
          'Tracks that fit the start of the arc. Pick one to open your set.'
        )}
      </p>

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
