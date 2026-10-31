import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import SearchBar from '@/components/SearchBar';
import { baseTitleOf, fmtDuration, groupVersions } from '@/components/VersionChip';
import type { Track } from '@/types/track';

const t = (id: string, title: string, over: Partial<Track> = {}): Track => ({ id, artist: 'CamelPhat', title, sources: {}, ...over });

const results: Track[] = [
  t('a', 'Cola', { durationMs: 190_000 }),
  t('p', 'Panic Room', { durationMs: 200_000 }),
  t('b', 'Cola (Extended Mix)', { version: 'Extended Mix', durationMs: 401_000 }),
  t('c', 'Cola (Mark Knight Remix)', { version: 'Mark Knight Remix', durationMs: 455_000 }),
];

afterEach(() => vi.unstubAllGlobals());

describe('search result helpers', () => {
  it('formats durations as m:ss', () => {
    expect(fmtDuration(401_000)).toBe('6:41');
    expect(fmtDuration(59_600)).toBe('1:00');
    expect(fmtDuration(undefined)).toBe('');
  });
  it('strips only the version suffix from the title', () => {
    expect(baseTitleOf({ title: 'Cola (Extended Mix)', version: 'Extended Mix' })).toBe('Cola');
    expect(baseTitleOf({ title: 'Delilah (pull me out of this)' })).toBe('Delilah (pull me out of this)');
  });
  it('keeps versions of the same work adjacent, in first-seen order', () => {
    expect(groupVersions(results).map((r) => r.id)).toEqual(['a', 'b', 'c', 'p']);
  });
});

describe('SearchBar', () => {
  it('shows a version chip and duration per result, grouped by work; Enter adds the top hit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tracks: results }))));
    const onAdd = vi.fn();
    render(<SearchBar onAdd={onAdd} inSet={new Set()} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'cola camelphat' } });

    const options = await screen.findAllByRole('option', {}, { timeout: 2000 });
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Cola'),
      expect.stringContaining('Extended Mix'),
      expect.stringContaining('Mark Knight Remix'),
      expect.stringContaining('Panic Room'),
    ]);
    expect(within(options[0]).queryByText('Extended Mix')).toBeNull();
    expect(within(options[1]).getByText('Cola')).toBeInTheDocument();
    expect(within(options[1]).getByText('6:41')).toBeInTheDocument();
    expect(within(options[0]).getByText('3:10')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith(results[0]);
  });

  it('debounces typing by at least 300ms and only searches the settled query', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tracks: [] })));
    vi.stubGlobal('fetch', fetchMock);
    render(<SearchBar onAdd={vi.fn()} inSet={new Set()} />);
    const input = screen.getByRole('combobox');
    for (const q of ['c', 'co', 'col', 'cola']) {
      fireEvent.change(input, { target: { value: q } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('q=cola');
    vi.useRealTimers();
  });
});
