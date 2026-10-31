import { vi } from 'vitest';
import type { Track } from '@/types/track';

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Stubs global fetch with a router: first matching [substring, responder] wins; unmatched calls reject. */
export function mockFetch(routes: Array<[string, () => Response | Promise<Response>]>) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = routes.find(([s]) => url.includes(s));
    if (!hit) throw new Error(`unrouted fetch: ${url}`);
    return hit[1]();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export const base = (over: Partial<Track> = {}): Track => ({
  id: 'daft punk|one more time',
  artist: 'Daft Punk',
  title: 'One More Time',
  sources: {},
  ...over,
});
