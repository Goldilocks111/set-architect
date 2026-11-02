'use client';

import { useEffect, useRef, useState } from 'react';
import PreviewPlayer from './PreviewPlayer';
import { fetchResolved, previewSource } from './trackFormat';
import { safeHttpUrl } from './trackSanitize';
import { arcLabel, toArc } from '@/lib/arc';
import type { Track } from '@/types/track';

export const RATING_STORAGE_KEY = 'setarch:rating:v2';

type Label = 'A' | 'B';
const LABELS: Label[] = ['A', 'B'];
interface RTrack { artist: string; title: string }
interface RList { label: Label; tracks: RTrack[] }
/** `arc` is a display label ("60 min build"). */
interface RScenario { id: string; name: string; arc?: string; set: RTrack[]; lists: RList[] }
export interface RatingFile { version: 2; fileId: string; scenarios: RScenario[] }
interface Entry { A?: number; B?: number; note?: string }
interface Saved { file: RatingFile; ratings: Record<string, Entry>; index: number }

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isRef = (v: any): v is RTrack => v && isStr(v.artist) && isStr(v.title);
const ref = ({ artist, title }: RTrack): RTrack => ({ artist, title });

/**
 * Accepts only the shape bench:recs writes (version 2: List A and List B per scenario); anything else is rejected
 * rather than half-rendered. Tracks keep artist/title only: nothing else may tell the lists apart.
 */
export function parseRatingFile(text: string): RatingFile | null {
  try {
    const j = JSON.parse(text);
    if (!j || j.version !== 2 || !isStr(j.fileId) || !Array.isArray(j.scenarios) || j.scenarios.length === 0) return null;
    const scenarios: RScenario[] = [];
    for (const s of j.scenarios) {
      if (!s || !isStr(s.id) || !isStr(s.name) || !Array.isArray(s.set) || !s.set.every(isRef) || !Array.isArray(s.lists)) return null;
      const lists: RList[] = [];
      for (const label of LABELS) {
        const l = s.lists.find((x: any) => x?.label === label);
        if (!l || !Array.isArray(l.tracks) || !l.tracks.every(isRef)) return null;
        lists.push({ label, tracks: l.tracks.map(ref) });
      }
      // files written before the minute arc carry `template` ('60min' / '120min') instead
      const arc = s.arc && typeof s.arc === 'object' ? arcLabel(toArc(s.arc)) : isStr(s.template) ? arcLabel(toArc(s.template)) : undefined;
      scenarios.push({ id: s.id, name: s.name, arc, set: s.set.map(ref), lists });
    }
    return { version: 2, fileId: j.fileId, scenarios };
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

/** Progress only: the verdict (engine vs baseline) is scored afterwards by bench:recs:ratings, never shown here. */
export function progress(file: RatingFile, ratings: Record<string, Entry>) {
  const rated = file.scenarios.reduce((n, s) => n + LABELS.filter((l) => ratings[s.id]?.[l] !== undefined).length, 0);
  return { rated, total: file.scenarios.length * LABELS.length };
}

function savedWhat(ratings: Record<string, Entry>): string {
  const all = Object.values(ratings);
  const r = all.reduce((n, e) => n + LABELS.filter((l) => e[l] !== undefined).length, 0);
  const n = all.filter((e) => e.note).length;
  const parts = [];
  if (r) parts.push(`${r} rating${r === 1 ? '' : 's'}`);
  if (n) parts.push(`${n} note${n === 1 ? '' : 's'}`);
  return parts.length ? `your ${parts.join(' and ')}` : 'your progress';
}

const ring = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2B33D]';
const linkCls = `text-[12px] text-[#8A8FA3] underline-offset-2 hover:text-[#E8E4DA] hover:underline ${ring}`;
const btn = `rounded-md border border-[#E8E4DA]/25 px-3 py-1.5 text-[13px] text-[#E8E4DA] hover:border-[#E8E4DA]/60 disabled:opacity-40 ${ring}`;

type Preview = { state: 'idle' } | { state: 'loading' } | { state: 'none' } | { state: 'found'; url: string };

/** No preview ships in the file (it would tell the lists apart, and expires anyway): the owner asks per track. */
function TrackRow({ t }: { t: RTrack }) {
  const [preview, setPreview] = useState<Preview>({ state: 'idle' });
  const label = `${t.artist} - ${t.title}`;
  const found = preview.state === 'found' ? preview : undefined;
  // always the same search link: a direct video URL (only some tracks have one) would tell the lists apart
  const yt = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${t.artist} ${t.title}`)}`; // same form as sources/youtube youtubeSearchUrl (not imported: that module is server-side)
  const find = async () => {
    setPreview({ state: 'loading' });
    const r = await fetchResolved(t);
    const url = safeHttpUrl(r?.previewUrl);
    setPreview(url ? { state: 'found', url } : { state: 'none' });
  };
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-[#E8E4DA]/10 bg-[#1A1D28] p-3">
      <div className="min-w-0">
        <p className="truncate font-[family-name:var(--font-display)] text-[15px] font-semibold text-[#E8E4DA]">{t.title}</p>
        <p className="truncate text-[13px] text-[#8A8FA3]">{t.artist}</p>
      </div>
      {found && <PreviewPlayer previewUrl={found.url} source={previewSource({ previewUrl: found.url, sources: {} } as Track)} label={label} />}
      <div className="flex flex-wrap items-center gap-3">
        {!found && (
          <button type="button" className={linkCls} disabled={preview.state === 'loading'} onClick={find} aria-label={`Find a preview: ${label}`}>
            {preview.state === 'loading' ? 'Finding…' : 'Find a preview'}
          </button>
        )}
        {preview.state === 'none' && <span className="text-[12px] text-[#8A8FA3]">No preview found</span>}
        <a href={yt} target="_blank" rel="noopener noreferrer" className={linkCls}>
          Search on YouTube
        </a>
      </div>
    </li>
  );
}

export default function RatingSession() {
  const [state, setState] = useState<Saved | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<RatingFile | null>(null);
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
      const hasRatings = !!state && Object.values(state.ratings).some((e) => e.A !== undefined || e.B !== undefined || e.note);
      if (state && JSON.stringify(state.file) === JSON.stringify(file)) return; // same file: nothing to replace, keep the progress
      if (hasRatings) return setPending(file); // a different file would wipe saved ratings: ask first
      update({ file, ratings: {}, index: 0 });
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsText(f);
  };

  const exportRatings = () => {
    if (!state) return;
    // A/B only: which list is the engine is in the bench results file, and bench:recs:ratings joins the two.
    const out = {
      exportedAt: new Date().toISOString(),
      fileId: state.file.fileId,
      ratings: state.file.scenarios.map((s) => {
        const e = state.ratings[s.id] ?? {};
        return { id: s.id, name: s.name, A: e.A ?? null, B: e.B ?? null, note: e.note ?? '' };
      }),
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
        <p className="text-[13px] text-[#8A8FA3]">Each scenario shows two lists of ten next-track candidates. Rate how relevant each list is as next picks, 1 to 10. No scores are shown.</p>
        {picker}
        {error && <p role="alert" className="text-[13px] text-[#F2B33D]">{error}</p>}
      </main>
    );
  }

  const { file, ratings, index } = state;
  const sc = file.scenarios[index];
  const entry = ratings[sc.id] ?? {};
  const sum = progress(file, ratings);
  const setEntry = (e: Entry) => update({ ...state, ratings: { ...ratings, [sc.id]: { ...entry, ...e } } });
  const go = (i: number) => update({ ...state, index: i });

  return (
    <main className={shell}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">Blind rating</h1>
        <p className="text-[13px] text-[#8A8FA3] tabular-nums">Scenario {index + 1} of {file.scenarios.length}</p>
      </header>

      <section aria-label="Scenario" className="flex flex-col gap-2">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold">{sc.name}{sc.arc ? <span className="ml-2 text-[13px] font-normal text-[#8A8FA3]">{sc.arc}</span> : null}</h2>
        <p className="text-[12px] tracking-wide text-[#8A8FA3] uppercase">The set so far</p>
        <ol className="list-decimal pl-5 text-[14px]">
          {sc.set.map((t, i) => <li key={i}>{t.artist} - {t.title}</li>)}
        </ol>
      </section>

      {sc.lists.map((l) => (
        <section key={l.label} aria-label={`List ${l.label}`} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-[family-name:var(--font-display)] text-[15px] font-semibold">List {l.label} <span className="text-[12px] font-normal text-[#8A8FA3]">{l.tracks.length} next-track candidates</span></h3>
            <label className="flex items-center gap-2 text-[14px]">
              Relevance (1-10)
              <select
                aria-label={`List ${l.label} relevance`}
                value={entry[l.label] ?? ''}
                onChange={(e) => setEntry({ [l.label]: e.target.value === '' ? undefined : Number(e.target.value) })}
                className={`rounded-md border border-[#E8E4DA]/25 bg-[#1A1D28] px-2 py-1 text-[#E8E4DA] ${ring}`}
              >
                <option value="">Not rated</option>
                {Array.from({ length: 10 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
              </select>
            </label>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {l.tracks.map((t, i) => <TrackRow key={`${sc.id}-${l.label}-${i}`} t={t} />)}
          </ul>
        </section>
      ))}

      <section aria-label="Your note" className="flex flex-col gap-2">
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
        <button className={btn} disabled={index === file.scenarios.length - 1} onClick={() => go(index + 1)}>Next</button>
        <button className={`${btn} ml-auto`} onClick={exportRatings}>Export ratings</button>
      </nav>

      <section aria-label="Progress" className="rounded-lg border border-[#E8E4DA]/10 bg-[#1A1D28] p-3 text-[14px]">
        <p role="status" className="tabular-nums text-[#8A8FA3]">
          {sum.rated === sum.total ? `All ${sum.total} lists rated. Export your ratings.` : `${sum.rated} of ${sum.total} lists rated`}
        </p>
      </section>

      {pending && (
        <div role="alertdialog" aria-label="Replace ratings" className="flex flex-col gap-2 rounded-lg border border-[#F2B33D]/50 bg-[#1A1D28] p-3 text-[14px]">
          <p>This is a different rating file. Replacing it deletes {savedWhat(state.ratings)}. Continue?</p>
          <div className="flex gap-2">
            <button className={btn} onClick={() => setPending(null)}>Keep my ratings</button>
            <button className={`${btn} border-[#F2B33D]/60`} onClick={() => { update({ file: pending, ratings: {}, index: 0 }); setPending(null); }}>Replace and start over</button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 border-t border-[#E8E4DA]/10 pt-3">
        {picker}
        {error && <p role="alert" className="text-[13px] text-[#F2B33D]">{error}</p>}
      </div>
    </main>
  );
}
