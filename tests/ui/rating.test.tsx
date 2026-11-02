import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RatingSession, { RATING_STORAGE_KEY, parseRatingFile, summarize } from '@/components/RatingSession';

const mkFile = (n = 10) => ({
  version: 1,
  scenarios: Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    name: `Scenario ${i}`,
    template: '60min',
    set: [{ artist: 'Set Artist', title: `Set Title ${i}` }],
    tracks: Array.from({ length: 10 }, (_, j) => ({
      artist: `Artist ${j}`, title: `Track ${i}-${j}`,
      ...(j === 0 ? { previewUrl: 'https://cdn-preview.dzcdn.net/p.mp3', youtubeUrl: 'https://youtu.be/abc' } : {}),
    })),
  })),
});
const upload = async (data: unknown) => {
  const f = new File([typeof data === 'string' ? data : JSON.stringify(data)], 'rating.json', { type: 'application/json' });
  fireEvent.change(screen.getByLabelText('Rating file'), { target: { files: [f] } });
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
};
const rate = (n: number) => fireEvent.change(screen.getByLabelText('Relevance rating'), { target: { value: String(n) } });

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('parseRatingFile', () => {
  it('rejects junk and wrong shapes, drops non-http urls', () => {
    expect(parseRatingFile('nope')).toBeNull();
    expect(parseRatingFile('{"scenarios":[]}')).toBeNull();
    expect(parseRatingFile('{"scenarios":[{"id":"a"}]}')).toBeNull();
    const f = mkFile(1);
    (f.scenarios[0].tracks[0] as any).youtubeUrl = 'javascript:alert(1)';
    expect(parseRatingFile(JSON.stringify(f))!.scenarios[0].tracks[0].youtubeUrl).toBeUndefined();
  });
});

describe('RatingSession', () => {
  it('shows the picker, then one scenario with its set and ten tracks, no scores', async () => {
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile());
    expect(await screen.findByText('Scenario 0')).toBeInTheDocument();
    expect(screen.getByText(/Set Title 0/)).toBeInTheDocument();
    expect(screen.getAllByText(/^Track 0-/)).toHaveLength(10);
    expect(screen.getByText('Open on YouTube').closest('a')).toHaveAttribute('href', 'https://youtu.be/abc');
    expect(screen.getAllByText('Search on YouTube')).toHaveLength(9);
    expect(document.querySelector('audio')).not.toBeNull();
    expect(screen.queryByText(/score|compliant|reason/i)).toBeNull();
  });

  it('rejects a bad file with an alert', async () => {
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    fireEvent.change(screen.getByLabelText('Rating file'), { target: { files: [new File(['{}'], 'x.json')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/not a rating file/i);
  });

  it('rates, navigates, and resumes from localStorage after a remount', async () => {
    const { unmount } = render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile());
    await screen.findByText('Scenario 0');
    rate(8);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'solid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Scenario 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Relevance rating')).toHaveValue('');
    unmount();

    render(<RatingSession />);
    expect(await screen.findByText('Scenario 1')).toBeInTheDocument(); // resumed where we left off
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByLabelText('Relevance rating')).toHaveValue('8');
    expect(screen.getByLabelText('Note')).toHaveValue('solid');
  });

  it('works when localStorage throws', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile(2));
    await screen.findByText('Scenario 0');
    rate(5);
    expect(screen.getByLabelText('Relevance rating')).toHaveValue('5');
    spy.mockRestore();
    get.mockRestore();
  });

  it('summary passes at 8 scenarios rated >= 7, not at 7', async () => {
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile());
    await screen.findByText('Scenario 0');
    for (let i = 0; i < 10; i++) {
      rate(i < 7 ? 7 : 6);
      if (i < 9) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    expect(screen.getByRole('status')).toHaveTextContent('Not passing');
    expect(screen.getByText(/7 of 10 scenarios rated 7 or higher/)).toBeInTheDocument();
    rate(9); // scenario 9 -> 8 good
    expect(screen.getByRole('status')).toHaveTextContent('PASS');
  });

  it('exports ratings as a JSON blob download', async () => {
    const created: Blob[] = [];
    const orig = { c: URL.createObjectURL, r: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:x')) as any;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<RatingSession />);
    await screen.findByLabelText('Rating file');
    await upload(mkFile(2));
    await screen.findByText('Scenario 0');
    rate(9);
    fireEvent.click(screen.getByRole('button', { name: 'Export ratings' }));
    expect(click).toHaveBeenCalledTimes(1);
    const body = JSON.parse(await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(created[0]); }));
    expect(body.ratings).toEqual([
      { id: 's0', name: 'Scenario 0', rating: 9, note: '' },
      { id: 's1', name: 'Scenario 1', rating: null, note: '' },
    ]);
    expect(body.summary).toMatchObject({ rated: 1, good: 1, total: 2 });
    click.mockRestore();
    URL.createObjectURL = orig.c;
    URL.revokeObjectURL = orig.r;
  });

  it('summarize counts unrated as not good', () => {
    expect(summarize(parseRatingFile(JSON.stringify(mkFile(3)))!, { s0: { rating: 7 }, s1: { rating: 6 } })).toEqual({ rated: 2, good: 1, total: 3, pass: false });
    expect(RATING_STORAGE_KEY).toMatch(/rating/);
  });
});
