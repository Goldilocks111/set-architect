import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import RatingSession, { RATING_STORAGE_KEY, parseRatingFile, progress } from '@/components/RatingSession';

const list = (i: number, label: 'A' | 'B') => ({
  label,
  tracks: Array.from({ length: 10 }, (_, j) => ({ artist: `Artist ${label}${j}`, title: `Track ${i}-${label}${j}` })),
});
const mkFile = (n = 10) => ({
  version: 2,
  fileId: 'f1',
  scenarios: Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    name: `Scenario ${i}`,
    template: '60min',
    set: [{ artist: 'Set Artist', title: `Set Title ${i}` }],
    lists: [list(i, 'A'), list(i, 'B')],
  })),
});
const upload = async (data: unknown) => {
  const f = new File([typeof data === 'string' ? data : JSON.stringify(data)], 'rating.json', { type: 'application/json' });
  fireEvent.change(screen.getByLabelText('Rating file'), { target: { files: [f] } });
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
};
const rate = (label: 'A' | 'B', n: number) => fireEvent.change(screen.getByLabelText(`List ${label} relevance`), { target: { value: String(n) } });

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('parseRatingFile', () => {
  it('rejects junk, wrong shapes and the old single-list format; keeps artist/title only', () => {
    expect(parseRatingFile('nope')).toBeNull();
    expect(parseRatingFile('{"scenarios":[]}')).toBeNull();
    expect(parseRatingFile('{"scenarios":[{"id":"a"}]}')).toBeNull();
    expect(parseRatingFile(JSON.stringify({ version: 1, scenarios: [{ id: 'a', name: 'n', set: [], tracks: [] }] }))).toBeNull();
    const f = mkFile(1);
    (f.scenarios[0].lists[0].tracks[0] as any).previewUrl = 'https://x/p.mp3';
    (f.scenarios[0].lists[0].tracks[0] as any).engine = true;
    expect(parseRatingFile(JSON.stringify(f))!.scenarios[0].lists[0].tracks[0]).toEqual({ artist: 'Artist A0', title: 'Track 0-A0' });
  });
});

describe('RatingSession', () => {
  it('shows one scenario with its set and two unlabelled lists of ten, no scores and no verdict', async () => {
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile());
    expect(await screen.findByText('Scenario 0')).toBeInTheDocument();
    expect(screen.getByText(/Set Title 0/)).toBeInTheDocument();
    const a = screen.getByRole('region', { name: 'List A' });
    const b = screen.getByRole('region', { name: 'List B' });
    expect(within(a).getAllByText(/^Track 0-A/)).toHaveLength(10);
    expect(within(b).getAllByText(/^Track 0-B/)).toHaveLength(10);
    expect(screen.getAllByText('Search on YouTube')).toHaveLength(20);
    expect(screen.queryByText(/score|compliant|reason|engine|baseline|PASS/i)).toBeNull();
  });

  it('"Find a preview" resolves that track on demand and plays the returned preview', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ track: { artist: 'Artist A3', title: 'Track 0-A3', previewUrl: 'https://cdn-preview.dzcdn.net/x.mp3', sources: {} } })));
    vi.stubGlobal('fetch', fetchMock);
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile(1));
    await screen.findByText('Scenario 0'); // the file is read asynchronously
    expect(document.querySelector('audio')).toBeNull();
    const a = screen.getByRole('region', { name: 'List A' });
    fireEvent.click(within(a).getAllByRole('button', { name: /Find a preview/ })[3]);
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/search/resolve?artist=Artist+A3&title=Track+0-A3');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the YouTube link is the same label and a search URL for every track, before and after a preview is found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ track: { artist: 'Artist A3', title: 'Track 0-A3', previewUrl: 'https://cdn-preview.dzcdn.net/x.mp3', youtubeUrl: 'https://www.youtube.com/watch?v=abc123', sources: {} } }))));
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile(1));
    await screen.findByText('Scenario 0');
    const a = screen.getByRole('region', { name: 'List A' });
    fireEvent.click(within(a).getAllByRole('button', { name: /Find a preview/ })[3]);
    await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    expect(screen.queryByText('Open on YouTube')).toBeNull();
    const links = screen.getAllByText('Search on YouTube');
    expect(links).toHaveLength(20);
    for (const l of links) expect(l.getAttribute('href')).toMatch(/^https:\/\/www\.youtube\.com\/results\?search_query=Artist%20/);
    expect(links.every((l) => !/watch\?v=/.test(l.getAttribute('href')!))).toBe(true);
    expect(within(a).getAllByText('Search on YouTube')[3].getAttribute('href')).toBe('https://www.youtube.com/results?search_query=Artist%20A3%20Track%200-A3');
  });

  it('says so when no preview is found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ track: { artist: 'x', title: 'y', sources: {} } }))));
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile(1));
    await screen.findByText('Scenario 0');
    fireEvent.click(screen.getAllByRole('button', { name: /Find a preview/ })[0]);
    expect(await screen.findByText('No preview found')).toBeInTheDocument();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('rejects a bad file with an alert', async () => {
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    fireEvent.change(screen.getByLabelText('Rating file'), { target: { files: [new File(['{}'], 'x.json')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/not a rating file/i);
  });

  it('rates both lists, navigates, and resumes from localStorage after a remount', async () => {
    const { unmount } = render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile());
    await screen.findByText('Scenario 0');
    rate('A', 8);
    rate('B', 4);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'solid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Scenario 1')).toBeInTheDocument();
    expect(screen.getByLabelText('List A relevance')).toHaveValue('');
    unmount();

    render(<RatingSession />);
    expect(await screen.findByText('Scenario 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByLabelText('List A relevance')).toHaveValue('8');
    expect(screen.getByLabelText('List B relevance')).toHaveValue('4');
    expect(screen.getByLabelText('Note')).toHaveValue('solid');
  });

  it('works when localStorage throws', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile(2));
    await screen.findByText('Scenario 0');
    rate('B', 5);
    expect(screen.getByLabelText('List B relevance')).toHaveValue('5');
    spy.mockRestore();
    get.mockRestore();
  });

  it('shows progress only (lists rated), never a pass/fail verdict', async () => {
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile(2));
    await screen.findByText('Scenario 0');
    rate('A', 9);
    expect(screen.getByRole('status')).toHaveTextContent('1 of 4 lists rated');
    rate('B', 9);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    rate('A', 2);
    rate('B', 2);
    expect(screen.getByRole('status')).toHaveTextContent(/All 4 lists rated/);
    expect(screen.queryByText(/PASS|Not passing|or higher/)).toBeNull();
  });

  it('exports A/B ratings with the file id, and nothing that says which list is which', async () => {
    const created: Blob[] = [];
    const orig = { c: URL.createObjectURL, r: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:x')) as any;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile(2));
    await screen.findByText('Scenario 0');
    rate('A', 9);
    rate('B', 3);
    fireEvent.click(screen.getByRole('button', { name: 'Export ratings' }));
    expect(click).toHaveBeenCalledTimes(1);
    const text = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(created[0]); });
    const body = JSON.parse(text);
    expect(body.fileId).toBe('f1');
    expect(body.ratings).toEqual([
      { id: 's0', name: 'Scenario 0', A: 9, B: 3, note: '' },
      { id: 's1', name: 'Scenario 1', A: null, B: null, note: '' },
    ]);
    expect(text).not.toMatch(/engine|baseline/);
    click.mockRestore();
    URL.createObjectURL = orig.c;
    URL.revokeObjectURL = orig.r;
  });

  it('re-picking the same file keeps saved ratings; a different file asks before wiping them', async () => {
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile(3));
    await screen.findByText('Scenario 0');
    rate('A', 8);
    await upload(mkFile(3));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByLabelText('List A relevance')).toHaveValue('8');

    const other = mkFile(3);
    other.scenarios[0].lists[0].tracks[1].title = 'Different';
    await upload(other);
    const dlg = await screen.findByRole('alertdialog');
    expect(dlg).toHaveTextContent(/replace/i);
    fireEvent.click(screen.getByRole('button', { name: 'Keep my ratings' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByLabelText('List A relevance')).toHaveValue('8');

    await upload(other);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace and start over' }));
    expect(screen.getByLabelText('List A relevance')).toHaveValue('');
    expect(screen.getByText('Different')).toBeInTheDocument();
  });

  it('the replace prompt talks about notes when only notes are saved', async () => {
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile(2));
    await screen.findByText('Scenario 0');
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'hm' } });
    const other = mkFile(2);
    other.scenarios[1].name = 'Changed';
    await upload(other);
    const dlg = await screen.findByRole('alertdialog');
    expect(dlg).toHaveTextContent(/\b1 note\b/);
    expect(dlg).not.toHaveTextContent(/\b0 ratings/);
  });

  it('progress counts rated lists', () => {
    expect(progress(parseRatingFile(JSON.stringify(mkFile(3)))!, { s0: { A: 7, B: 2 }, s1: { A: 6 } })).toEqual({ rated: 3, total: 6 });
    expect(RATING_STORAGE_KEY).toMatch(/rating/);
  });
});
