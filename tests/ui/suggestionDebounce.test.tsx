import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import SuggestionBox, { ENRICH_DEBOUNCE_MS } from '@/components/SuggestionBox';
import type { Track } from '@/types/track';

const t = (id: string, extra: Partial<Track> = {}): Track => ({ id, artist: `A ${id}`, title: `T ${id}`, sources: {}, ...extra });

let fetchMock: ReturnType<typeof vi.fn>;
const suggestCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === '/api/suggest').length;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ suggestions: [] })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('<SuggestionBox /> refresh debounce', () => {
  const box = (tracks: Track[]) => <SuggestionBox tracks={tracks} arc={{ minutes: 60, shape: 'build' }} onAdd={() => {}} />;

  it('resolving/failed churn (same ids, same essentials, new arrays) does not refetch', async () => {
    const { rerender } = render(box([t('a'), t('b')]));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(suggestCalls()).toBe(1);
    for (let i = 0; i < 5; i++) {
      rerender(box([t('a'), t('b', { unresolved: { reason: 'timeout', missing: ['bpm', 'camelot', 'energy', 'danceability'] } })]));
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(suggestCalls()).toBe(1);
  });

  it(`a burst of resolved answers refreshes once, no sooner than ${1500} ms after the last one`, async () => {
    expect(ENRICH_DEBOUNCE_MS).toBeGreaterThanOrEqual(1500);
    const { rerender } = render(box([t('a'), t('b'), t('c')]));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(suggestCalls()).toBe(1);
    rerender(box([t('a', { bpm: 120 }), t('b'), t('c')]));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    rerender(box([t('a', { bpm: 120 }), t('b', { bpm: 122 }), t('c')]));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    rerender(box([t('a', { bpm: 120 }), t('b', { bpm: 122 }), t('c', { bpm: 124 })]));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_400); });
    expect(suggestCalls()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(suggestCalls()).toBe(2);
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
    expect(body.playlist.map((x: Track) => x.bpm)).toEqual([120, 122, 124]); // the latest tracks are sent
  });

  it('adding a track (a user action) still refreshes promptly', async () => {
    const { rerender } = render(box([t('a')]));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    rerender(box([t('a'), t('b')]));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(suggestCalls()).toBe(2);
  });
});
