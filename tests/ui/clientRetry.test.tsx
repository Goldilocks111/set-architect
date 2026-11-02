import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import Builder, { CLIENT_TIMEOUT_RETRY_MS, RETRY_JITTER_MS, RETRY_SETTLE_MS } from '@/components/Builder';
import { STORAGE_KEY } from '@/components/persistence';
import type { Track } from '@/types/track';

const complete = (id: string): Track => ({
  id, artist: `Artist ${id}`, title: `Title ${id}`, bpm: 124, camelot: '8A', energy: 6, danceability: 0.7, sources: {},
});
// no energy: the danceability prior can't complete these
const incomplete = (id: string): Track => ({ id, artist: `Artist ${id}`, title: `Title ${id}`, sources: {} });

const MIN = 60_000;
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));

let resolveCalls: string[];
/** Routes /api/search/resolve to `onResolve(n, url, init)` (n = 1-based call count for that url); everything else answers empty. */
function stubFetch(onResolve: (n: number, url: string, init?: RequestInit) => Promise<Response>) {
  const counts = new Map<string, number>();
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/search/resolve')) {
      resolveCalls.push(u);
      const n = (counts.get(u) ?? 0) + 1;
      counts.set(u, n);
      return onResolve(n, u, init);
    }
    if (u.startsWith('/api/spotify/status')) return ok({ connected: true, displayName: 'DJ Zed' });
    if (u.startsWith('/api/spotify/playlists/p1/tracks'))
      return ok({ tracks: [1, 2, 3, 4, 5].map((n) => ({ artist: `S${n}`, title: `Song ${n}`, spotifyId: `id${n}` })) });
    if (u.startsWith('/api/spotify/playlists')) return ok({ playlists: [{ id: 'p1', name: 'Warmup', trackCount: 5 }] });
    return ok({ suggestions: [] });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const callsFor = (id: string) => resolveCalls.filter((u) => u.includes(`Title+${id}`)).length;
const advance = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const mount = async (tracks: Track[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '60min', tracks }));
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<Builder demo getSongBpmConfigured={false} />); });
  return view;
};
const retryWindow = RETRY_SETTLE_MS + RETRY_JITTER_MS;

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  localStorage.clear();
  resolveCalls = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('<Builder /> client re-asks after a retryable verdict (I1)', () => {
  it('re-requests once at the server retryAt and picks up the server-side result', async () => {
    stubFetch((n) => {
      if (n === 1) {
        return ok({ track: { ...incomplete('a'), unresolved: { reason: 'providers-unavailable', missing: ['bpm', 'camelot', 'energy', 'danceability'], retryAt: Date.now() + 5 * MIN } } });
      }
      return ok({ track: complete('a') });
    });
    await mount([incomplete('a')]);
    await advance(100);
    expect(callsFor('a')).toBe(1);
    expect(screen.getByText(/Providers busy — retrying automatically/)).toBeInTheDocument();
    await advance(5 * MIN - 1_000);
    expect(callsFor('a')).toBe(1); // not before retryAt
    await advance(retryWindow + 2_000);
    expect(callsFor('a')).toBe(2);
    expect(screen.getByText('Complete')).toBeInTheDocument();
    await advance(60 * MIN);
    expect(callsFor('a')).toBe(2);
  });

  it('follows a new retryAt from the re-request, but never re-arms the same retryAt twice', async () => {
    const at = Date.now() + 5 * MIN;
    stubFetch(() => ok({ track: { ...incomplete('a'), unresolved: { reason: 'timeout', missing: ['bpm', 'camelot', 'energy', 'danceability'], retryAt: at } } }));
    await mount([incomplete('a')]);
    await advance(5 * MIN + retryWindow + 1_000);
    expect(callsFor('a')).toBe(2);
    await advance(120 * MIN);
    expect(callsFor('a')).toBe(2); // the server answered with the same (past) retryAt: no loop
  });

  it('a client-side 60 s timeout without retryAt gets exactly one re-request after 5 min', async () => {
    expect(CLIENT_TIMEOUT_RETRY_MS).toBe(5 * MIN);
    stubFetch((_n, _u, init) => hang(init));
    await mount([incomplete('a')]);
    await advance(61_000);
    expect(screen.getByText(/Still looking — retrying automatically/)).toBeInTheDocument();
    expect(callsFor('a')).toBe(1);
    // the hung request is aborted at 120 s; the re-request comes 5 min after that verdict
    await advance(59_000); // separate act() scopes: React flushes effects when each one ends
    await advance(5 * MIN + RETRY_JITTER_MS + 1_000);
    expect(callsFor('a')).toBe(2);
    await advance(60 * MIN);
    expect(callsFor('a')).toBe(2);
  });

  it('clears pending retry timers on unmount', async () => {
    stubFetch(() => ok({ track: { ...incomplete('a'), unresolved: { reason: 'providers-unavailable', missing: ['bpm', 'camelot', 'energy', 'danceability'], retryAt: Date.now() + 5 * MIN } } }));
    const view = await mount([incomplete('a')]);
    await advance(100);
    view.unmount();
    await advance(10 * MIN);
    expect(callsFor('a')).toBe(1);
  });

  it('removing a track cancels its retry timer', async () => {
    stubFetch(() => ok({ track: { ...incomplete('a'), unresolved: { reason: 'providers-unavailable', missing: ['bpm', 'camelot', 'energy', 'danceability'], retryAt: Date.now() + 5 * MIN } } }));
    await mount([incomplete('a')]);
    await advance(100);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Title a from the set' }));
    await advance(10 * MIN);
    expect(callsFor('a')).toBe(1);
  });

  it('a permanent reason is never re-asked', async () => {
    stubFetch(() => ok({ track: { ...incomplete('a'), unresolved: { reason: 'not-found', missing: ['bpm', 'camelot', 'energy', 'danceability'] } } }));
    await mount([incomplete('a')]);
    await advance(60 * MIN);
    expect(callsFor('a')).toBe(1);
  });
});

describe('<Builder /> queue (I1)', () => {
  it('skips queued fetches for tracks removed from the set', async () => {
    stubFetch((_n, _u, init) => hang(init));
    await mount([1, 2, 3, 4].map((n) => incomplete(`t${n}`)));
    expect(resolveCalls).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Title t3 from the set' }));
    await advance(121_000); // the first two hard-abort, freeing both slots
    expect(callsFor('t3')).toBe(0);
    expect(callsFor('t4')).toBe(1);
  });

  it('Spotify "Add all" goes through the in-flight cap', async () => {
    stubFetch((_n, _u, init) => hang(init));
    await mount([]);
    fireEvent.click(await screen.findByRole('button', { name: 'DJ Zed' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import playlist…' }));
    fireEvent.click(await screen.findByRole('button', { name: /Warmup/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add all (5)' }));
    await advance(100);
    expect(screen.getAllByText('Resolving…')).toHaveLength(5);
    expect(resolveCalls).toHaveLength(2);
  });

});
