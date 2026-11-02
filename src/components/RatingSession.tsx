'use client';

import { useEffect, useRef, useState } from 'react';
import PreviewPlayer from './PreviewPlayer';
import { previewSource } from './trackFormat';
import { safeHttpUrl } from './trackSanitize';
import type { Track } from '@/types/track';

export const RATING_STORAGE_KEY = 'setarch:rating:v1';
export const PASS_RATING = 7;
export const PASS_SCENARIOS = 8;

interface RTrack { artist: string; title: string; previewUrl?: string; youtubeUrl?: string }
interface RScenario { id: string; name: string; template?: string; set: Array<{ artist: string; title: string }>; tracks: RTrack[] }
export interface RatingFile { version: 1; scenarios: RScenario[] }
interface Entry { rating?: number; note?: string }
interface Saved { file: RatingFile; ratings: Record<string, Entry>; index: number }

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isRef = (v: any): v is { artist: string; title: string } => v && isStr(v.artist) && isStr(v.title);

/** Accepts only the shape bench:recs writes; anything else is rejected rather than half-rendered. */
export function parseRatingFile(text: string): RatingFile | null {
  try {
    const j = JSON.parse(text);
    if (!j || !Array.isArray(j.scenarios) || j.scenarios.length === 0) return null;
    const scenarios: RScenario[] = [];
    for (const s of j.scenarios) {
      if (!s || !isStr(s.id) || !isStr(s.name) || !Array.isArray(s.set) || !Array.isArray(s.tracks)) return null;
      if (!s.set.every(isRef) || !s.tracks.every(isRef)) return null;
      scenarios.push({
        id: s.id, name: s.name, template: typeof s.template === 'string' ? s.template : undefined,
        set: s.set.map(({ artist, title }: RTrack) => ({ artist, title })),
        tracks: s.tracks.map((t: RTrack) => ({ artist: t.artist, title: t.title, previewUrl: safeHttpUrl(t.previewUrl), youtubeUrl: safeHttpUrl(t.youtubeUrl) })),
      });
    }
    return { version: 1, scenarios };
  } catch {
    return null;
  }
}

function load(): Saved | null {
  try {
    const raw = window.localStorage.getItem(RATING_STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Saved;
    const file = parseRatingFile(JSON.stringify(s.file));
    return file ? { file, ratings: s.ratings ?? {}, index: Math.min(Math.max(0, s.index | 0), file.scenarios.length - 1) } : null;
  } catch {
    return null;
  }
}

function save(s: Saved): void {
  try {
    window.localStorage.setItem(RATING_STORAGE_KEY, JSON.stringify(s));
  } catch {
    // storage blocked or full: ratings still live in memory (and Export still works)
  }
}

/** The whole session verdict: >= 8 scenarios rated >= 7 (of however many the file holds). */
export function summarize(file: RatingFile, ratings: Record<string, Entry>) {
  const rated = file.scenarios.filter((s) => ratings[s.id]?.rating !== undefined).length;
  const good = file.scenarios.filter((s) => (ratings[s.id]?.rating ?? 0) >= PASS_RATING).length;
  return { rated, good, total: file.scenarios.length, pass: good >= PASS_SCENARIOS };
}

const ring = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D]';
const linkCls = `text-[12px] text-[#8A8FA3] underline-offset-2 hover:text-[#E8E4DA] hover:underline ${ring}`;
const btn = `rounded-md border border-[#E8E4DA]/25 px-3 py-1.5 text-[13px] text-[#E8E4DA] hover:border-[#E8E4DA]/60 disabled:opacity-40 ${ring}`;

function TrackRow({ t }: { t: RTrack }) {
  const label = `${t.artist} - ${t.title}`;
  const yt = t.youtubeUrl ?? `https://www.youtube.com/results?search_query=${encodeURIComponent(label)}`;
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-[#E8E4DA]/10 bg-[#1A1D28] p-3">
      <div className="min-w-0">
        <p className="truncate font-[family-name:var(--font-display)] text-[15px] font-semibold text-[#E8E4DA]">{t.title}</p>
        <p className="truncate text-[13px] text-[#8A8FA3]">{t.artist}</p>
      </div>
      {t.previewUrl && <PreviewPlayer previewUrl={t.previewUrl} source={previewSource({ previewUrl: t.previewUrl, sources: {} } as Track)} label={label} />}
      <a href={yt} target="_blank" rel="noopener noreferrer" className={`self-start ${linkCls}`}>
        {t.youtubeUrl ? 'Open on YouTube' : 'Search on YouTube'}
      </a>
    </li>
  );
}

export default function RatingSession() {
  const [state, setState] = useState<Saved | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);

  useEffect(() => {
    setState(load());
    setReady(true);
    mounted.current = true;
  }, []);

  const update = (next: Saved) => {
    setState(next);
    save(next);
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const file = parseRatingFile(String(reader.result));
      if (!file) return setError('That is not a rating file from bench:recs.');
      setError('');
      update({ file, ratings: {}, index: 0 });
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsText(f);
  };

  const exportRatings = () => {
    if (!state) return;
    const out = {
      exportedAt: new Date().toISOString(),
      summary: summarize(state.file, state.ratings),
      ratings: state.file.scenarios.map((s) => ({ id: s.id, name: s.name, rating: state.ratings[s.id]?.rating ?? null, note: state.ratings[s.id]?.note ?? '' })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'setarchitect-ratings.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!ready) return <main className="mx-auto max-w-3xl p-6 text-[#8A8FA3]">Loading…</main>;

  const shell = 'mx-auto flex min-h-screen max-w-3xl flex-col gap-5 bg-[#12141C] p-6 text-[#E8E4DA]';
  const picker = (
    <label className={`inline-flex cursor-pointer flex-col gap-1 text-[13px] text-[#8A8FA3]`}>
      Rating file (from <code>npm run bench:recs</code>)
      <input type="file" accept="application/json,.json" aria-label="Rating file" onChange={(e) => onFile(e.target.files?.[0])} className="text-[13px] text-[#E8E4DA]" />
    </label>
  );

  if (!state) {
    return (
      <main className={shell}>
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">Blind rating</h1>
        <p className="text-[13px] text-[#8A8FA3]">Rate how relevant each scenario&apos;s ten tracks are as next picks, 1 to 10. No scores are shown.</p>
        {picker}
        {error && <p role="alert" className="text-[13px] text-[#F2B33D]">{error}</p>}
      </main>
    );
  }

  const { file, ratings, index } = state;
  const sc = file.scenarios[index];
  const entry = ratings[sc.id] ?? {};
  const sum = summarize(file, ratings);
  const setEntry = (e: Entry) => update({ ...state, ratings: { ...ratings, [sc.id]: { ...entry, ...e } } });
  const go = (i: number) => update({ ...state, index: i });

  return (
    <main className={shell}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">Blind rating</h1>
        <p className="text-[13px] text-[#8A8FA3] tabular-nums">Scenario {index + 1} of {sum.total} · {sum.rated} rated</p>
      </header>

      <section aria-label="Scenario" className="flex flex-col gap-2">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold">{sc.name}{sc.template ? <span className="ml-2 text-[13px] font-normal text-[#8A8FA3]">{sc.template}</span> : null}</h2>
        <p className="text-[12px] tracking-wide text-[#8A8FA3] uppercase">The set so far</p>
        <ol className="list-decimal pl-5 text-[14px]">
          {sc.set.map((t, i) => <li key={i}>{t.artist} - {t.title}</li>)}
        </ol>
      </section>

      <section aria-label="Suggestions" className="flex flex-col gap-2">
        <p className="text-[12px] tracking-wide text-[#8A8FA3] uppercase">Ten next-track candidates (shuffled)</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {sc.tracks.map((t, i) => <TrackRow key={i} t={t} />)}
        </ul>
      </section>

      <section aria-label="Your rating" className="flex flex-col gap-2">
        <label className="flex items-center gap-3 text-[14px]">
          Relevance (1-10)
          <select
            aria-label="Relevance rating"
            value={entry.rating ?? ''}
            onChange={(e) => setEntry({ rating: e.target.value === '' ? undefined : Number(e.target.value) })}
            className={`rounded-md border border-[#E8E4DA]/25 bg-[#1A1D28] px-2 py-1 text-[#E8E4DA] ${ring}`}
          >
            <option value="">Not rated</option>
            {Array.from({ length: 10 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
          </select>
        </label>
        <textarea
          aria-label="Note"
          placeholder="Optional note"
          value={entry.note ?? ''}
          onChange={(e) => setEntry({ note: e.target.value })}
          rows={2}
          className={`w-full rounded-md border border-[#E8E4DA]/25 bg-[#1A1D28] p-2 text-[13px] text-[#E8E4DA] ${ring}`}
        />
      </section>

      <nav className="flex flex-wrap items-center gap-2">
        <button className={btn} disabled={index === 0} onClick={() => go(index - 1)}>Previous</button>
        <button className={btn} disabled={index === sum.total - 1} onClick={() => go(index + 1)}>Next</button>
        <button className={`${btn} ml-auto`} onClick={exportRatings}>Export ratings</button>
      </nav>

      <section aria-label="Summary" className="rounded-lg border border-[#E8E4DA]/10 bg-[#1A1D28] p-3 text-[14px]">
        <p className="tabular-nums">{sum.good} of {sum.total} scenarios rated {PASS_RATING} or higher (need {PASS_SCENARIOS}).</p>
        <p role="status" className={sum.pass ? 'font-semibold text-[#F2B33D]' : 'text-[#8A8FA3]'}>
          {sum.pass ? 'PASS' : sum.rated === sum.total ? 'Not passing' : `${sum.total - sum.rated} still to rate`}
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-4 border-t border-[#E8E4DA]/10 pt-3">
        {picker}
        {error && <p role="alert" className="text-[13px] text-[#F2B33D]">{error}</p>}
      </div>
    </main>
  );
}
