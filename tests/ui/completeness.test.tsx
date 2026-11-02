import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CompletenessBadge from '@/components/CompletenessBadge';
import SetList from '@/components/SetList';
import SearchBar from '@/components/SearchBar';
import SuggestionCard from '@/components/SuggestionCard';
import Builder from '@/components/Builder';
import { STORAGE_KEY } from '@/components/persistence';
import { quarantineForCurve } from '@/components/curveData';
import { needsMetadata } from '@/components/trackFormat';
import { initialPlaylistState, playlistReducer } from '@/components/playlistReducer';
import type { Track } from '@/types/track';

const complete = (id: string, extra: Partial<Track> = {}): Track => ({
  id, artist: `Artist ${id}`, title: `Title ${id}`, bpm: 124, camelot: '8A', energy: 6, danceability: 0.7, sources: {}, ...extra,
});
const incomplete = (id: string, extra: Partial<Track> = {}): Track => ({
  id, artist: `Artist ${id}`, title: `Title ${id}`, bpm: 124, camelot: '8A', energy: 6, sources: {},
  unresolved: { reason: 'no-preview', missing: ['danceability'] }, ...extra,
});

describe('needsMetadata', () => {
  it('treats a track missing only danceability as needing metadata', () => {
    expect(needsMetadata({ ...complete('a'), danceability: undefined })).toBe(true);
    expect(needsMetadata(complete('a'))).toBe(false);
    expect(needsMetadata({ ...complete('a'), danceability: 0 })).toBe(false);
  });
});

describe('<CompletenessBadge />', () => {
  it('renders Complete', () => {
    render(<CompletenessBadge track={complete('a')} resolving={false} />);
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });
  it('renders Resolving… while in flight', () => {
    render(<CompletenessBadge track={incomplete('a')} resolving />);
    expect(screen.getByText('Resolving…')).toBeInTheDocument();
  });
  it.each([
    ['not-found', 'No provider has this track'],
    ['no-preview', 'No preview to analyse — set values by hand'],
    ['analysis-failed', 'Couldn’t analyse the preview — set values by hand'],
    ['providers-unavailable', 'Providers busy — retrying automatically'],
    ['timeout', 'Still looking — retrying automatically'],
    ['exhausted', 'Couldn’t find full data after several tries — set values by hand'],
  ] as const)('renders reason %s verbatim and lists missing fields', (reason, copy) => {
    const t = incomplete('a', { bpm: undefined, danceability: undefined, unresolved: { reason, missing: ['bpm', 'danceability'] } });
    render(<CompletenessBadge track={t} resolving={false} />);
    expect(screen.getByText(`Incomplete — ${copy}`)).toBeInTheDocument();
    expect(screen.getByText(/Missing: BPM, danceability/)).toBeInTheDocument();
  });
});

describe('<SetList /> quarantine', () => {
  it('marks incomplete rows quarantined and complete rows not', () => {
    render(<SetList tracks={[complete('a'), incomplete('b')]} arc={{ minutes: 60, shape: 'build' }} onRemove={() => {}} onMove={() => {}} />);
    const rows = within(screen.getByRole('list', { name: 'Set list' })).getAllByRole('listitem');
    const byTitle = (t: string) => rows.find((r) => within(r).queryByText(t))!;
    expect(byTitle('Title a')).toHaveAttribute('data-quarantined', 'false');
    expect(byTitle('Title b')).toHaveAttribute('data-quarantined', 'true');
    expect(byTitle('Title b').className).toMatch(/opacity-/);
  });
  it('shows all four essentials on a complete row', () => {
    render(<SetList tracks={[complete('a')]} arc={{ minutes: 60, shape: 'build' }} onRemove={() => {}} onMove={() => {}} />);
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('8A');
    expect(row).toHaveTextContent('124 BPM');
    expect(row).toHaveTextContent('E6');
    expect(row).toHaveTextContent('D0.70');
  });
  it('excludes quarantined tracks from the energy curve line', () => {
    const out = quarantineForCurve([complete('a'), incomplete('b')]);
    expect(out[0].energy).toBe(6);
    expect(out[1].energy).toBeUndefined();
  });
  it('the editor saves four fields through onOverride', async () => {
    const onOverride = vi.fn(async () => null);
    render(<SetList tracks={[incomplete('b', { bpm: undefined })]} arc={{ minutes: 60, shape: 'build' }} onRemove={() => {}} onMove={() => {}} onOverride={onOverride} />);
    fireEvent.click(screen.getByRole('button', { name: /edit values/i }));
    fireEvent.change(screen.getByLabelText('BPM'), { target: { value: '128' } });
    fireEvent.change(screen.getByLabelText('Danceability'), { target: { value: '0.5' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(onOverride).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), { bpm: 128, danceability: 0.5 });
  });
  it('rejects an invalid value in the editor without calling onOverride', async () => {
    const onOverride = vi.fn(async () => null);
    render(<SetList tracks={[incomplete('b')]} arc={{ minutes: 60, shape: 'build' }} onRemove={() => {}} onMove={() => {}} onOverride={onOverride} />);
    fireEvent.click(screen.getByRole('button', { name: /edit values/i }));
    fireEvent.change(screen.getByLabelText('BPM'), { target: { value: '500' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(onOverride).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/bpm/i);
  });
});

describe('override editor: only changed fields', () => {
  it('ignores an out-of-range untouched provider value and sends nothing for it', async () => {
    const onOverride = vi.fn(async () => null);
    render(<SetList tracks={[incomplete('h', { bpm: 210 })]} arc={{ minutes: 60, shape: 'build' }} onRemove={() => {}} onMove={() => {}} onOverride={onOverride} />);
    fireEvent.click(screen.getByRole('button', { name: /edit values/i }));
    fireEvent.change(screen.getByLabelText('Danceability'), { target: { value: '0.9' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(onOverride).toHaveBeenCalledWith(expect.anything(), { danceability: 0.9 });
  });
  it('saving with no change shows an error and does not call onOverride', async () => {
    const onOverride = vi.fn(async () => null);
    render(<SetList tracks={[incomplete('h')]} arc={{ minutes: 60, shape: 'build' }} onRemove={() => {}} onMove={() => {}} onOverride={onOverride} />);
    fireEvent.click(screen.getByRole('button', { name: /edit values/i }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(onOverride).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
  it('untouched fields keep their provider source after an override', () => {
    const t = incomplete('p', { sources: { bpm: 'getsongbpm', energy: 'acousticbrainz' } });
    const s = playlistReducer({ ...initialPlaylistState, tracks: [t] }, { type: 'override', id: 'p', fields: { danceability: 0.4 } });
    expect(s.tracks[0].sources).toMatchObject({ bpm: 'getsongbpm', energy: 'acousticbrainz', danceability: 'manual' });
  });
});

describe('compact completeness marks', () => {
  it('SearchBar results show a neutral not-yet-analysed state with missing fields', async () => {
    const hit: Track = { id: 'h1', artist: 'Hit Artist', title: 'Hit Title', bpm: 120, sources: {} };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tracks: [hit] }))));
    render(<SearchBar onAdd={() => {}} inSet={new Set()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hit art' } });
    expect(await screen.findByText(/Not yet analysed/)).toBeInTheDocument();
    expect(screen.getByText(/missing key, energy, danceability/i)).toBeInTheDocument();
    expect(screen.queryByText(/Incomplete/)).toBeNull();
    vi.unstubAllGlobals();
  });
  it('SuggestionCard shows a Complete mark for a complete track', () => {
    render(<SuggestionCard suggestion={{ track: complete('s'), score: 0.8, reasons: [] }} onAdd={() => {}} />);
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });
});

describe('reducer: resolve + override', () => {
  const base = { ...initialPlaylistState, tracks: [incomplete('a', { energy: undefined, unresolved: { reason: 'timeout', missing: ['energy', 'danceability'] } })] };
  it('resolved merges fields and clears unresolved when complete', () => {
    const s = playlistReducer({ ...base, resolving: ['a'] }, { type: 'resolved', id: 'a', track: complete('a') });
    expect(s.tracks[0].unresolved).toBeUndefined();
    expect(s.tracks[0].energy).toBe(6);
    expect(s.resolving).toEqual([]);
  });
  it('resolved updates unresolved reason while still incomplete', () => {
    const r = { ...complete('a'), danceability: undefined, unresolved: { reason: 'analysis-failed' as const, missing: ['danceability' as const] } };
    const s = playlistReducer(base, { type: 'resolved', id: 'a', track: r });
    expect(s.tracks[0].unresolved).toEqual({ reason: 'analysis-failed', missing: ['danceability'] });
  });
  it('manual override wins over later resolve', () => {
    let s = playlistReducer(base, { type: 'override', id: 'a', fields: { bpm: 130, energy: 9, danceability: 0.3 } });
    expect(s.tracks[0]).toMatchObject({ bpm: 130, energy: 9, danceability: 0.3 });
    expect(s.tracks[0].sources).toMatchObject({ bpm: 'manual', energy: 'manual' });
    expect(s.tracks[0].unresolved).toBeUndefined();
    s = playlistReducer(s, { type: 'resolved', id: 'a', track: complete('a', { bpm: 100, energy: 2, sources: { bpm: 'x' } }) });
    expect(s.tracks[0]).toMatchObject({ bpm: 130, energy: 9 });
    expect(s.tracks[0].sources.bpm).toBe('manual');
  });
  it('resolveFailed marks incomplete with the reason', () => {
    const s = playlistReducer({ ...base, resolving: ['a'] }, { type: 'resolveFailed', id: 'a', reason: 'timeout' });
    expect(s.resolving).toEqual([]);
    expect(s.tracks[0].unresolved?.reason).toBe('timeout');
  });
  it('load drops resolving', () => {
    const s = playlistReducer({ ...base, resolving: ['a'] }, { type: 'load', state: base });
    expect(s.resolving ?? []).toEqual([]);
  });
});

describe('<Builder /> resolving lifecycle', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  });
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const hangingFetch = () =>
    vi.fn((url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/search/resolve')) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      return Promise.resolve(new Response(JSON.stringify({ suggestions: [] })));
    });

  it('on load re-requests incomplete tracks only, then shows Resolving… that flips to timeout after 60 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '60min', tracks: [complete('ok'), incomplete('bad')] }));
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    const resolveCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/search/resolve'));
    expect(resolveCalls()).toHaveLength(1);
    expect(String(resolveCalls()[0][0])).toContain('Title+bad');
    expect(screen.getByText('Resolving…')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
    expect(screen.getByText('Resolving…')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.queryByText('Resolving…')).toBeNull();
    expect(screen.getByText('Incomplete — Still looking — retrying automatically')).toBeInTheDocument();
  });

  it('applies a resolved track and clears the incomplete state', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '60min', tracks: [incomplete('bad')] }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).startsWith('/api/search/resolve')
        ? new Response(JSON.stringify({ track: complete('bad') }))
        : new Response(JSON.stringify({ suggestions: [] }))));
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    await waitFor(() => expect(screen.getByText('Complete')).toBeInTheDocument());
    expect(screen.getByRole('listitem')).toHaveAttribute('data-quarantined', 'false');
  });

  it('caps in-flight re-requests at 2', async () => {
    const tracks = [1, 2, 3, 4].map((n) => incomplete(`t${n}`));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '60min', tracks }));
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/search/resolve'))).toHaveLength(2);
  });

  it('the 60 s clock starts at enqueue: no track shows Resolving… after 60 s, and a late answer still applies', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const tracks = [1, 2, 3, 4, 5].map((n) => incomplete(`t${n}`));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '60min', tracks }));
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    expect(screen.getAllByText('Resolving…')).toHaveLength(5);
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(screen.queryByText('Resolving…')).toBeNull();
    expect(screen.getAllByText('Incomplete — Still looking — retrying automatically')).toHaveLength(5);
  });

  it('a track dequeued after its clock fired never flips back to Resolving…', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const tracks = [1, 2, 3, 4, 5].map((n) => incomplete(`t${n}`));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '60min', tracks }));
    const answerAfter = (ms: number, body: unknown) => new Promise<Response>((r) => setTimeout(() => r(new Response(JSON.stringify(body))), ms));
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const u = String(url);
      if (!u.startsWith('/api/search/resolve')) return Promise.resolve(new Response(JSON.stringify({ suggestions: [] })));
      if (u.includes('Title+t1') || u.includes('Title+t2')) return answerAfter(70_000, { track: incomplete('x') });
      if (u.includes('Title+t3')) return answerAfter(30_000, { track: complete('t3') }); // starts at 70 s, lands at 100 s
      return new Promise<Response>(() => {}); // t4, t5 never answer
    }));
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    expect(screen.getAllByText('Resolving…')).toHaveLength(5);
    for (const at of [61_000, 90_000, 125_000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(at - (at === 61_000 ? 0 : at === 90_000 ? 61_000 : 90_000)); });
      expect(screen.queryByText('Resolving…')).toBeNull();
    }
    // t3 answered at ~100 s: Complete; the other four stay incomplete
    expect(screen.getAllByText('Complete')).toHaveLength(1);
    expect(screen.getAllByText(/^Incomplete — /)).toHaveLength(4);
  });

  it('a queued request that answers after the cap still applies', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '60min', tracks: [incomplete('slow')] }));
    let release!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      String(url).startsWith('/api/search/resolve')
        ? new Promise<Response>((r) => { release = r; })
        : Promise.resolve(new Response(JSON.stringify({ suggestions: [] })))));
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(screen.getByText(/Incomplete — Still looking/)).toBeInTheDocument();
    await act(async () => { release(new Response(JSON.stringify({ track: complete('slow') }))); });
    await waitFor(() => expect(screen.getByText('Complete')).toBeInTheDocument());
  });

  it('saving an override POSTs and shows the track complete', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '60min', tracks: [incomplete('bad')] }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === '/api/tracks/override') return new Response(JSON.stringify({ track: complete('bad') }));
      if (String(url).startsWith('/api/search/resolve')) return new Response(JSON.stringify({ track: incomplete('bad') }));
      return new Response(JSON.stringify({ suggestions: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    fireEvent.click(screen.getByRole('button', { name: /edit values/i }));
    fireEvent.change(screen.getByLabelText('Danceability'), { target: { value: '0.4' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/tracks/override')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ artist: 'Artist bad', title: 'Title bad', fields: { danceability: 0.4 } });
    await waitFor(() => expect(screen.getByText('Complete')).toBeInTheDocument());
  });
});
