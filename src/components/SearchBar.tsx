'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { Track } from '@/types/track';
import { displayTitle, fmtBpm, fmtEnergy } from './trackFormat';

interface Props {
  onAdd: (track: Track) => void;
  inSet: Set<string>;
}

type Status = 'idle' | 'loading' | 'done' | 'error';

export default function SearchBar({ onAdd, inSet }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Track[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setStatus('idle');
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setStatus('loading');
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { tracks: Track[] };
        setResults(body.tracks ?? []);
        setActive(0);
        setStatus('done');
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setStatus('error');
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  const shown = results.slice(0, 8);

  const add = (track: Track | undefined) => {
    if (!track || inSet.has(track.id)) return;
    onAdd(track);
    setQuery('');
    setResults([]);
    inputRef.current?.focus();
  };

  return (
    <div className="relative">
      <label htmlFor={`${listId}-input`} className="sr-only">
        Search for a track to add
      </label>
      <div className="flex items-center gap-2 rounded-lg border border-[#2A2F3F] bg-[#12141C] px-3 focus-within:border-[#F2B33D]/70">
        <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0 stroke-[#8A8FA3]" fill="none" strokeWidth="1.6">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="search"
          autoComplete="off"
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-activedescendant={shown.length ? `${listId}-${active}` : undefined}
          placeholder="Search artist or title, Enter adds the top hit"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(shown[active]);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Escape') {
              setQuery('');
            }
          }}
          className="h-11 w-full bg-transparent text-[15px] text-[#E8E4DA] placeholder:text-[#8A8FA3]/70 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {status === 'loading' && <span className="shrink-0 text-xs text-[#8A8FA3]">Searching…</span>}
      </div>

      {query.trim() && (status === 'done' || status === 'error') && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-[#2A2F3F] bg-[#1A1D28] shadow-2xl shadow-black/50">
          {status === 'error' && <p className="px-4 py-3 text-sm text-[#EE8B7A]">Search failed. Check your connection and try again.</p>}
          {status === 'done' && shown.length === 0 && (
            <p className="px-4 py-3 text-sm text-[#8A8FA3]">No tracks match &ldquo;{query.trim()}&rdquo;. Try just the artist name.</p>
          )}
          {shown.length > 0 && (
            <ul id={listId} role="listbox" aria-label="Search results" className="max-h-80 overflow-y-auto py-1">
              {shown.map((t, i) => {
                const added = inSet.has(t.id);
                return (
                  <li
                    key={t.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={added}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      add(t);
                    }}
                    className={`grid cursor-pointer grid-cols-[1fr_auto] items-center gap-3 px-4 py-2 ${
                      i === active ? 'bg-[#232838]' : ''
                    } ${added ? 'cursor-default opacity-45' : ''}`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-[#E8E4DA]">{displayTitle(t)}</div>
                      <div className="truncate text-xs text-[#8A8FA3]">{t.artist}</div>
                    </div>
                    <div className="flex gap-2 text-xs text-[#8A8FA3] tabular-nums">
                      {added ? (
                        <span>In set</span>
                      ) : (
                        <>
                          <span className="text-[#C9CEDF]">{t.camelot ?? 'key ?'}</span>
                          <span>{fmtBpm(t.bpm)}</span>
                          <span>E{fmtEnergy(t.energy)}</span>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
