import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MikImport from '@/components/MikImport';
import Builder from '@/components/Builder';
import { STORAGE_KEY } from '@/components/persistence';
import type { Track } from '@/types/track';

const track = (id: string, artist: string, title: string, extra: Partial<Track> = {}): Track => ({ id, artist, title, sources: {}, ...extra });
const csv = (text: string) => new File([text], 'mik.csv', { type: 'text/csv' });

/** Echoes a batch back the way the route does: rejects bpm > 200. */
function batchFetch() {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { items } = JSON.parse(String(init?.body)) as { items: Array<{ fields: { bpm?: number } }> };
    const rejected = items.flatMap((it, index) => (it.fields.bpm && it.fields.bpm > 200 ? [{ index, error: 'bpm must be a number from 60 to 200' }] : []));
    return Response.json({ applied: items.length - rejected.length, rejected, tracks: [] });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('<MikImport />', () => {
  it('sends the Time column as durationMs and applies it to matching set tracks', async () => {
    const fetchMock = batchFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onApply = vi.fn();
    const { container } = render(<MikImport tracks={[track('t1', 'Artist A', 'Song One')]} onApply={onApply} />);
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [csv('Artist,Title,Key,Time\nArtist A,Song One,8A,6:30\n')] } });
    await waitFor(() => expect(onApply).toHaveBeenCalled());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).items[0].fields).toEqual({ camelot: '8A', durationMs: 390000 });
    expect(onApply).toHaveBeenCalledWith([{ id: 't1', fields: { camelot: '8A', durationMs: 390000 } }]);
  });
  it('posts parsed rows as one batch, applies to matching set tracks, and reports counts', async () => {
    const fetchMock = batchFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onApply = vi.fn();
    const tracks = [track('t1', 'Artist A', 'Song One'), track('t2', 'Someone', 'Else')];
    const { container } = render(<MikImport tracks={tracks} onApply={onApply} />);
    const text = 'Artist,Title,Key,BPM,Energy\nArtist A,Song One (Extended Mix),F#m,124,7\nOther,Not in set,8A,128,5\nBad,Tempo,8A,280,5\nNo,Data,nope,,\n';
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [csv(text)] } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Imported 2, matched 1 in this set, skipped 2'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toEqual({ artist: 'Artist A', title: 'Song One (Extended Mix)', fields: { bpm: 124, camelot: '11A', energy: 7 } });
    expect(onApply).toHaveBeenCalledWith([{ id: 't1', fields: { bpm: 124, camelot: '11A', energy: 7 } }]);
  });

  it('chunks above 2000 rows', async () => {
    const fetchMock = batchFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<MikImport tracks={[]} onApply={vi.fn()} />);
    const lines = Array.from({ length: 2001 }, (_, i) => `A${i},T${i},8A,120,5`).join('\n');
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [csv(`Artist,Title,Key,BPM,Energy\n${lines}`)] } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Imported 2001, matched 0 in this set, skipped 0'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).items).toHaveLength(2000);
  });

  it('reports a failed later chunk, counts unimported rows, and still updates chunk 1 matches', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (++calls === 2) return Response.json({ error: 'Server busy' }, { status: 500 });
      const { items } = JSON.parse(String(init?.body)) as { items: unknown[] };
      return Response.json({ applied: items.length, rejected: [], tracks: [] });
    }));
    const onApply = vi.fn();
    const { container } = render(<MikImport tracks={[track('t1', 'A0', 'T0'), track('t2', 'A2500', 'T2500')]} onApply={onApply} />);
    const lines = Array.from({ length: 2600 }, (_, i) => `A${i},T${i},8A,120,5`).join('\n');
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [csv(`Artist,Title,Key,BPM,Energy\n${lines}`)] } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Stopped: Server busy'));
    expect(screen.getByRole('status')).toHaveTextContent('Imported 2000, matched 1 in this set, skipped 0');
    expect(screen.getByRole('status')).toHaveTextContent('600 rows not imported');
    expect(onApply).toHaveBeenCalledWith([{ id: 't1', fields: { bpm: 120, camelot: '8A', energy: 5 } }]);
  });

  it('says so when nothing usable is in the file, without calling the server', async () => {
    const fetchMock = batchFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<MikImport tracks={[]} onApply={vi.fn()} />);
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [csv('Foo,Bar\n1,2')] } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No usable rows'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server error and applies nothing on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Sign in to edit track values.' }, { status: 401 })));
    const onApply = vi.fn();
    const { container } = render(<MikImport tracks={[track('t1', 'A', 'B')]} onApply={onApply} />);
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [csv('Artist,Title,BPM\nA,B,120')] } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sign in to edit track values.'));
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('Builder with MIK import', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  it('enriches a set track from the imported file; bpm/key/energy rows are completed by the danceability prior', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tracks: [track('t1', 'Artist A', 'Song One')], template: '60min' }));
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url).includes('/api/tracks/override')) return batchFetch()(url, init);
      return Response.json({}, { status: 404 });
    }));
    const { container } = render(<Builder demo getSongBpmConfigured={false} />);
    await act(async () => {});
    const before = urls.length; // the load itself re-requests the incomplete track
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [csv('Artist,Title,Key,BPM,Energy\nArtist A,Song One,8A,126,6')] } });
    await waitFor(() => expect(screen.getByText(/Imported 1, matched 1 in this set/)).toBeInTheDocument());
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.tracks[0]).toMatchObject({ bpm: 126, camelot: '8A', energy: 6 });
    expect(stored.tracks[0].sources.bpm).toBe('manual');
    expect(stored.tracks[0]).toMatchObject({ danceability: 0.75, sources: { danceability: 'estimate-prior' } });
    expect(stored.tracks[0].unresolved).toBeUndefined();
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(urls.slice(before).some((u) => u.startsWith('/api/search/resolve'))).toBe(false); // nothing left to resolve
  });
});
