import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SetList from '@/components/SetList';
import Builder from '@/components/Builder';
import { transitionParts } from '@/components/TransitionBadge';
import { STORAGE_KEY } from '@/components/persistence';
import type { Track } from '@/types/track';

const full = (id: string, camelot: string, bpm: number, energy: number): Track => ({
  id,
  artist: `Artist ${id}`,
  title: `Title ${id}`,
  camelot,
  bpm,
  energy,
  sources: {},
});
const partial: Track = { id: 'p', artist: 'Mystery', title: 'Unknown Data', sources: {} };

describe('transitionParts', () => {
  it('scores known dimensions and marks unknown ones without a score', () => {
    const parts = transitionParts({ from: full('a', '8A', 124, 5), to: partial, position: 1, template: '60min', plannedLength: 15 });
    expect(parts.map((p) => p.detail)).toEqual(['Key unknown', 'BPM unknown', 'Energy unknown']);
    expect(parts.every((p) => p.score === undefined)).toBe(true);
  });

  it('describes a direct mix', () => {
    const parts = transitionParts({ from: full('a', '8A', 124, 5), to: full('b', '8A', 125, 6), position: 1, template: '60min', plannedLength: 15 });
    expect(parts[0].text).toBe('8A→8A');
    expect(parts[1].text).toBe('+1 BPM');
    expect(parts[2].text).toBe('E +1');
    parts.forEach((p) => expect(Number.isFinite(p.score)).toBe(true));
  });
});

describe('<SetList /> Spotify link-out', () => {
  it('renders only for tracks with spotifyUrl', () => {
    const withUrl = { ...full('a', '8A', 124, 5), spotifyUrl: 'https://open.spotify.com/track/a' };
    render(
      <SetList tracks={[withUrl, full('b', '8A', 124, 5)]} template="60min" plannedLength={15} onRemove={() => {}} onMove={() => {}} />
    );
    const links = screen.getAllByRole('link', { name: /in Spotify/i, hidden: true });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://open.spotify.com/track/a');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0].getAttribute('rel')).toContain('noopener');
  });
});

describe('<SetList />', () => {
  it('renders rows with a transition badge between each pair, partial data shows placeholders', () => {
    const { container } = render(
      <SetList
        tracks={[full('a', '8A', 124, 5), partial, full('c', '9A', 125, 6)]}
        template="60min"
        plannedLength={15}
        onRemove={() => {}}
        onMove={() => {}}
      />
    );
    expect(screen.getAllByLabelText(/^Transition:/)).toHaveLength(2);
    expect(container.textContent).not.toMatch(/NaN|undefined/);
    expect(screen.getAllByText('key ?').length).toBeGreaterThan(0);
  });

  it('move/remove buttons call back with indices and ids', () => {
    const onMove = vi.fn();
    const onRemove = vi.fn();
    render(
      <SetList tracks={[full('a', '8A', 124, 5), full('b', '8A', 124, 5)]} template="60min" plannedLength={15} onRemove={onRemove} onMove={onMove} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move Title b up' }));
    expect(onMove).toHaveBeenCalledWith(1, 0);
    expect(screen.getByRole('button', { name: 'Move Title a up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Title a from the set' }));
    expect(onRemove).toHaveBeenCalledWith('a');
  });
});

describe('<Builder />', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('shows the demo banner, restores the set from localStorage, and requests suggestions', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '60min', tracks: [full('a', '8A', 124, 5)] }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ suggestions: [] })));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      render(<Builder demo getSongBpmConfigured={false} />);
    });
    expect(screen.getByText(/demo mode/i)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Set list' })).getByText('Title a')).toBeInTheDocument();
    expect(screen.queryByText(/GetSongBPM/)).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/suggest', expect.objectContaining({ method: 'POST' })));
  });

  it('renders the GetSongBPM backlink when configured and hides the demo banner outside demo mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ suggestions: [], playlists: [] }))));
    await act(async () => {
      render(<Builder demo={false} getSongBpmConfigured />);
    });
    expect(screen.queryByText(/demo mode/i)).toBeNull();
    expect(screen.getByRole('link', { name: /getsongbpm/i })).toHaveAttribute('href', 'https://getsongbpm.com');
  });
});
