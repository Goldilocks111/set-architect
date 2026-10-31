import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SuggestionCard from '@/components/SuggestionCard';
import type { Suggestion } from '@/types/track';

const base: Suggestion = {
  track: {
    id: 's1',
    artist: 'Ben Böhmer',
    title: 'Beyond Beliefs',
    bpm: 122,
    camelot: '8A',
    energy: 5,
    sources: {},
  },
  score: 0.8637,
  reasons: [
    { kind: 'key', label: 'Smooth (9A → 8A)', score: 0.9 },
    { kind: 'bpm', label: '0 BPM', score: 1 },
    { kind: 'energy', label: 'Holds energy', score: 0.8 },
    { kind: 'cooccurrence', label: 'Played after Brightest Lights in 5 real sets', score: 1 },
    { kind: 'similarity', label: 'Similar artist (Last.fm)', score: 0.4 },
  ],
};

describe('<SuggestionCard />', () => {
  it('shows the track, a 0–100 score, and every reason as a labelled chip', () => {
    render(<SuggestionCard suggestion={base} onAdd={() => {}} />);
    expect(screen.getByText('Beyond Beliefs')).toBeInTheDocument();
    expect(screen.getByText('Ben Böhmer')).toBeInTheDocument();
    expect(screen.getByLabelText(/match score 86/i)).toBeInTheDocument();
    const chips = screen.getAllByRole('listitem');
    expect(chips).toHaveLength(5);
    for (const r of base.reasons) expect(screen.getByText(r.label)).toBeInTheDocument();
    expect(chips[0]).toHaveAttribute('data-kind', 'key');
    expect(chips[3]).toHaveAttribute('data-kind', 'cooccurrence');
    expect(screen.getByText('In real sets')).toBeInTheDocument();
  });

  it('calls onAdd with the track', () => {
    const onAdd = vi.fn();
    render(<SuggestionCard suggestion={base} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole('button', { name: /add beyond beliefs/i }));
    expect(onAdd).toHaveBeenCalledWith(base.track);
  });

  it('with no previewUrl: no audio, no iTunes badge; YouTube search link-out constructed', () => {
    const { container } = render(<SuggestionCard suggestion={base} onAdd={() => {}} />);
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.queryByText(/courtesy of itunes/i)).toBeNull();
    const yt = screen.getByRole('link', { name: /youtube/i });
    expect(yt.getAttribute('href')).toBe(
      'https://www.youtube.com/results?search_query=' + encodeURIComponent('Ben Böhmer Beyond Beliefs')
    );
    expect(yt).toHaveAttribute('target', '_blank');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('with previewUrl: visible audio player + iTunes badge link + attribution', () => {
    const s: Suggestion = {
      ...base,
      track: {
        ...base.track,
        previewUrl: 'https://audio-ssl.itunes.apple.com/x.m4a',
        itunesUrl: 'https://music.apple.com/us/album/x?i=1',
        youtubeUrl: 'https://www.youtube.com/watch?v=abc',
      },
    };
    const { container } = render(<SuggestionCard suggestion={s} onAdd={() => {}} />);
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute('src', 'https://audio-ssl.itunes.apple.com/x.m4a');
    expect(audio).toHaveAttribute('controls');
    expect(screen.getByRole('link', { name: /available on itunes/i })).toHaveAttribute(
      'href',
      'https://music.apple.com/us/album/x?i=1'
    );
    expect(screen.getByText(/previews provided courtesy of itunes/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /youtube/i })).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abc');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('renders partial-data tracks (unknown bpm/key/energy) without NaN', () => {
    const s: Suggestion = { track: { id: 'p', artist: 'X', title: 'Y', sources: {} }, score: Number.NaN, reasons: [] };
    const { container } = render(<SuggestionCard suggestion={s} onAdd={() => {}} />);
    expect(container.textContent).not.toMatch(/NaN|undefined/);
  });

  it('Deezer-sourced preview gets Deezer attribution, never the iTunes badge', () => {
    const s: Suggestion = {
      ...base,
      track: { ...base.track, previewUrl: 'https://cdnt-preview.dzcdn.net/x.mp3', sources: { previewUrl: 'deezer' } },
    };
    const { container } = render(<SuggestionCard suggestion={s} onAdd={() => {}} />);
    expect(container.querySelector('audio')).not.toBeNull();
    expect(screen.getByText(/preview provided by deezer/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /itunes/i })).toBeNull();
    expect(screen.queryByText(/courtesy of itunes/i)).toBeNull();
  });

  it('"Find a preview" resolves the track and shows a visible player', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          track: { ...base.track, previewUrl: 'https://audio-ssl.itunes.apple.com/y.m4a', sources: { previewUrl: 'itunes' } },
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<SuggestionCard suggestion={base} onAdd={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /find a preview/i }));
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/search/resolve?artist=');
    expect(screen.getByText(/previews provided courtesy of itunes/i)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
