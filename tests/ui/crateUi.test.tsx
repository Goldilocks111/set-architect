import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Builder from '@/components/Builder';
import CratePanel from '@/components/CratePanel';
import MikImport from '@/components/MikImport';
import SpotifyConnect from '@/components/SpotifyConnect';
import SuggestionBox from '@/components/SuggestionBox';
import { CRATE_KEY, loadCrate, type CrateTrack } from '@/components/crate';
import { STORAGE_KEY } from '@/components/persistence';
import type { Track } from '@/types/track';

const full = { bpm: 124, camelot: '8A', energy: 6, danceability: 0.7 };
const t = (id: string, extra: Partial<Track> = {}): Track => ({ id, artist: `Artist ${id}`, title: `Title ${id}`, sources: {}, ...extra });
const item = (n: number, extra: Partial<CrateTrack> = {}): CrateTrack => ({
  id: `c${n}`, artist: `CA ${n}`, title: `CT ${n}`, addedAt: n, from: 'spotify', ...extra,
});

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('<CratePanel />', () => {
  it('shows the import hint for an empty crate', () => {
    render(<CratePanel crate={[]} onRemove={vi.fn()} onClear={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Import a Spotify playlist or a Mixed In Key CSV to fill your crate — suggestions come from it first.')).toBeInTheDocument();
  });

  it('lists tracks newest first, removes one, clears all after confirming', () => {
    const onRemove = vi.fn();
    const onClear = vi.fn();
    render(<CratePanel crate={[item(1, full), item(2)]} onRemove={onRemove} onClear={onClear} onClose={vi.fn()} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('CT 2');
    expect(rows[0]).toHaveTextContent('incomplete');
    expect(rows[1]).toHaveTextContent('CT 1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove CT 1 from crate' }));
    expect(onRemove).toHaveBeenCalledWith('c1');
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Clear crate' }));
    expect(onClear).not.toHaveBeenCalled();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear crate' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('<MikImport /> crate hand-off', () => {
  it('hands every accepted row to onImported, in or out of the set', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      const { items } = JSON.parse(String(init?.body)) as { items: unknown[] };
      return Response.json({ applied: items.length, rejected: [], tracks: [] });
    }));
    const onImported = vi.fn();
    const { container } = render(<MikImport tracks={[]} onApply={vi.fn()} onImported={onImported} />);
    const file = new File(['Artist,Title,Key,BPM,Energy\nOther,Not in set,8A,128,5\n'], 'mik.csv', { type: 'text/csv' });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } });
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(onImported).toHaveBeenCalledWith([{ artist: 'Other', title: 'Not in set', fields: { bpm: 128, camelot: '8A', energy: 5 } }]);
  });
});

describe('<SuggestionBox /> sends the crate', () => {
  it('posts the crate minus set tracks, complete first', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ suggestions: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const set = [t('s1', full)];
    const crate = [item(1), item(2, full), { ...item(3, full), artist: 'Artist s1', title: 'Title s1' }];
    render(<SuggestionBox tracks={set} template="60min" plannedLength={15} onAdd={vi.fn()} crate={crate} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 2000 });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.crate.map((c: CrateTrack) => c.id)).toEqual(['c2', 'c1']);
  });

  it('hints how to fill the crate while it is small', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ suggestions: [] }))));
    render(<SuggestionBox tracks={[]} template="60min" plannedLength={15} onAdd={vi.fn()} crate={[]} />);
    expect(screen.getByText(/Import a Spotify playlist or a Mixed In Key CSV to fill your crate/)).toBeInTheDocument();
    await act(async () => {});
  });
});

function stubApi() {
  const fn = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.startsWith('/api/spotify/status')) return Response.json({ connected: true, displayName: 'DJ Zed' });
    if (u.startsWith('/api/spotify/playlists/p1/tracks'))
      return Response.json({ tracks: [1, 2, 3].map((n) => ({ artist: `S${n}`, title: `Song ${n}`, spotifyId: `id${n}` })) });
    if (u.startsWith('/api/spotify/playlists')) return Response.json({ playlists: [{ id: 'p1', name: 'Warmup', trackCount: 3 }] });
    if (u.startsWith('/api/search/resolve')) return Response.json({});
    if (u.startsWith('/api/search')) return Response.json({ tracks: [t('found', full)] });
    return Response.json({ suggestions: [] });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('<Builder /> crate', () => {
  it('starts empty, then counts tracks that are in the set', async () => {
    stubApi();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '60min', tracks: [t('a', full), t('b', full)] }));
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    expect(screen.getByRole('button', { name: 'Crate: 2 tracks' })).toBeInTheDocument();
    expect(loadCrate().map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  it('every set add also enters the crate', async () => {
    stubApi();
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    expect(screen.getByRole('button', { name: 'Crate: 0 tracks' })).toBeInTheDocument();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'found' } });
    await screen.findAllByRole('option', {}, { timeout: 2000 });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Crate: 1 track' })).toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem(CRATE_KEY)!)[0]).toMatchObject({ id: 'found', from: 'set', ...full });
  });

  it('opens the panel and removes a track', async () => {
    stubApi();
    localStorage.setItem(CRATE_KEY, JSON.stringify([item(1, full), item(2, full)]));
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    fireEvent.click(screen.getByRole('button', { name: 'Crate: 2 tracks' }));
    const dialog = screen.getByRole('dialog', { name: 'Crate' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove CT 1 from crate' }));
    expect(screen.getByRole('button', { name: 'Crate: 1 track' })).toBeInTheDocument();
    expect(loadCrate().map((c) => c.id)).toEqual(['c2']);
  });

  it('Spotify "Add all to crate" fills the crate without touching the set', async () => {
    stubApi();
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    fireEvent.click(await screen.findByRole('button', { name: 'DJ Zed' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import playlist…' }));
    fireEvent.click(await screen.findByRole('button', { name: /Warmup/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add all to crate (3)' }));
    expect(await screen.findByText(/3 tracks added to your crate/)).toBeInTheDocument();
    expect(loadCrate()).toHaveLength(3);
    expect(loadCrate().every((c) => c.from === 'spotify')).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{"tracks":[]}').tracks).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Crate: 3 tracks' })).toBeInTheDocument();
  });

  it('imported MIK rows join the crate even when not in the set', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/api/tracks/override')) {
        const { items } = JSON.parse(String(init?.body)) as { items: unknown[] };
        return Response.json({ applied: items.length, rejected: [], tracks: [] });
      }
      return Response.json({ suggestions: [] });
    }));
    const { container } = render(<Builder demo getSongBpmConfigured={false} />);
    await act(async () => {});
    const file = new File(['Artist,Title,Key,BPM,Energy\nOther,Not in set,8A,128,5\n'], 'mik.csv', { type: 'text/csv' });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Crate: 1 track' })).toBeInTheDocument());
    expect(loadCrate()[0]).toMatchObject({ artist: 'Other', title: 'Not in set', bpm: 128, camelot: '8A', energy: 5, danceability: 0.7, from: 'mik' });
  });
});

describe('<SpotifyConnect /> without a crate handler', () => {
  it('has no crate button', async () => {
    stubApi();
    render(<SpotifyConnect tracks={[]} onAdd={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'DJ Zed' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import playlist…' }));
    fireEvent.click(await screen.findByRole('button', { name: /Warmup/ }));
    await screen.findByRole('button', { name: 'Add all (3)' });
    expect(screen.queryByRole('button', { name: /to crate/ })).toBeNull();
  });
});
