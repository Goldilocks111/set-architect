import { describe, expect, it, vi } from 'vitest';
import { BenchRefused, createFetchGuard } from '../../bench/data/guardFetch';
import { RequestGate } from '../../bench/search/guard';

const mk = (budgets: Record<string, number>, respond: (url: string) => Response, gapMs: Record<string, number> = {}) => {
  const real = vi.fn(async (u: any) => respond(String(u)));
  const gates = new Map(Object.entries(budgets).map(([k, b]) => [k, new RequestGate(b)]));
  let t = 0;
  const sleeps: number[] = [];
  const g = createFetchGuard({
    real: real as any,
    gates,
    gapMs,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { g, real, gates, sleeps, tick: (ms: number) => (t += ms) };
};
const ok = () => new Response('{}', { status: 200 });

describe('createFetchGuard', () => {
  it('refuses calls past the budget without touching the network', async () => {
    const { g, real } = mk({ spotify: 2 }, ok);
    await g.fetch('https://api.spotify.com/v1/search');
    await g.fetch('https://api.spotify.com/v1/search');
    await expect(g.fetch('https://api.spotify.com/v1/search')).rejects.toBeInstanceOf(BenchRefused);
    expect(real).toHaveBeenCalledTimes(2);
    expect(g.refused.spotify).toBe(1);
  });

  it('a 429 stops that provider (no further calls) but not others', async () => {
    const { g, real } = mk({ spotify: 10, deezer: 10 }, (u) =>
      u.includes('spotify') ? new Response('', { status: 429, headers: { 'retry-after': '99' } }) : ok(),
    );
    const res = await g.fetch('https://api.spotify.com/v1/search');
    expect(res.status).toBe(429);
    expect(g.stopped.get('spotify')).toContain('429');
    await expect(g.fetch('https://accounts.spotify.com/api/token')).rejects.toBeInstanceOf(BenchRefused);
    expect(real).toHaveBeenCalledTimes(1);
    await g.fetch('https://api.deezer.com/search');
    expect(real).toHaveBeenCalledTimes(2);
  });

  it('treats Deezer HTTP-200 quota error body as rate-limited', async () => {
    const { g, real } = mk({ deezer: 10 }, () => new Response(JSON.stringify({ error: { code: 4, message: 'Quota limit exceeded' } })));
    await g.fetch('https://api.deezer.com/search?q=x');
    expect(g.stopped.has('deezer')).toBe(true);
    await expect(g.fetch('https://api.deezer.com/search?q=y')).rejects.toBeInstanceOf(BenchRefused);
    expect(real).toHaveBeenCalledTimes(1);
  });

  it('leaves the response body readable after the quota check', async () => {
    const { g } = mk({ deezer: 10 }, () => new Response('{"data":[1]}'));
    const res = await g.fetch('https://api.deezer.com/search');
    expect(await res.json()).toEqual({ data: [1] });
    expect(g.stopped.size).toBe(0);
  });

  it('passes the Deezer preview CDN and unknown hosts through uncounted', async () => {
    const { g, real, gates } = mk({ deezer: 1 }, ok);
    for (let i = 0; i < 5; i++) await g.fetch('https://cdnt-preview.dzcdn.net/api/1/1/a.mp3');
    await g.fetch('https://acousticbrainz.org/api/v1/low-level');
    expect(real).toHaveBeenCalledTimes(6);
    expect(gates.get('deezer')!.count).toBe(0);
  });

  it('paces calls per provider', async () => {
    const { g, sleeps, tick } = mk({ musicbrainz: 10 }, ok, { musicbrainz: 1100 });
    await g.fetch('https://musicbrainz.org/ws/2/a');
    tick(300);
    await g.fetch('https://musicbrainz.org/ws/2/b');
    expect(sleeps).toEqual([800]);
  });
});
