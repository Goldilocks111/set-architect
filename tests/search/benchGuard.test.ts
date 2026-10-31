import { describe, expect, it } from 'vitest';
import {
  BenchThrottled,
  REQUEST_BUDGET,
  budgetFor,
  dayKey,
  guardProvider,
  loadDailyCounts,
  saveDailyCounts,
  RequestGate,
  degradedSummary,
  isRateLimited,
  runStatus,
  selectSingleProviders,
  type Breaker,
} from '../../bench/search/guard';

const prov = (name: string, configured = true) => ({ name, configured: () => configured });
const breakerWith = (open: Record<string, number>): Breaker => ({
  cooldownUntil: (n, now = 0) => (open[n] && open[n] > now ? open[n] : 0),
  recordFailure: () => {},
});

describe('request budget', () => {
  it('has the agreed per-provider defaults', () => {
    expect(REQUEST_BUDGET).toMatchObject({ spotify: 150, deezer: 400, itunes: 150, musicbrainz: 200 });
  });
  it('refuses requests past the budget', () => {
    const g = new RequestGate(2);
    expect([g.take(), g.take(), g.take()]).toEqual([true, true, false]);
    expect(g.count).toBe(2);
  });
  it('is unlimited without a budget', () => {
    const g = new RequestGate(undefined);
    for (let i = 0; i < 1000; i++) expect(g.take()).toBe(true);
  });
});

describe('rate-limit detection', () => {
  it('treats 429 as a lockout for every provider and a bare 403 only for iTunes', () => {
    expect(isRateLimited('spotify', { status: 429 })).toBe(true);
    expect(isRateLimited('deezer', { status: 429 })).toBe(true);
    expect(isRateLimited('itunes', { status: 403 })).toBe(true);
    expect(isRateLimited('spotify', { status: 403 })).toBe(false);
    expect(isRateLimited('deezer', new Error('boom'))).toBe(false);
  });
});

describe('provider selection', () => {
  it('excludes musicbrainz from single-provider targets', () => {
    const { run, skipped } = selectSingleProviders([prov('deezer'), prov('musicbrainz')], null);
    expect(run.map((p) => p.name)).toEqual(['deezer']);
    expect(skipped.map((s) => s.name)).toEqual(['musicbrainz']);
  });
  it('skips providers whose breaker is open and reports the unlock time', () => {
    const now = 1_000;
    const { run, skipped } = selectSingleProviders(
      [prov('spotify'), prov('deezer'), prov('itunes', false)],
      breakerWith({ spotify: 5_000 }),
      now,
    );
    expect(run.map((p) => p.name)).toEqual(['deezer']);
    expect(skipped).toEqual(
      expect.arrayContaining([
        { name: 'spotify', reason: 'breaker open', until: 5_000 },
        { name: 'itunes', reason: 'not configured' },
      ]),
    );
  });
  it('runs a provider once its cooldown has passed', () => {
    const { run } = selectSingleProviders([prov('spotify')], breakerWith({ spotify: 500 }), 1_000);
    expect(run).toHaveLength(1);
  });
});

describe('degraded accounting and run status', () => {
  const q = (d: string[], n: number) => Array.from({ length: n }, () => d);
  it('counts degraded providers per query', () => {
    const s = degradedSummary([['spotify'], [], ['spotify', 'deezer'], []]);
    expect(s.text).toBe('spotify:2/4 deezer:1/4');
  });
  it('flags a provider degraded on more than 10% of queries as INVALID', () => {
    const dg = degradedSummary([...q(['spotify'], 12), ...q([], 88)]);
    expect(dg.invalid).toEqual(['spotify']);
    expect(runStatus({ degradedInvalid: dg.invalid, errored: 0, total: 100, budgetExceeded: false })).toMatch(/^INVALID \(degraded/);
  });
  it('does not flag exactly 10%', () => {
    expect(degradedSummary([...q(['deezer'], 10), ...q([], 90)]).invalid).toEqual([]);
  });
  it('marks aborted and errored runs', () => {
    const base = { degradedInvalid: [], errored: 0, total: 130, budgetExceeded: false };
    expect(runStatus(base)).toBe('ok');
    expect(runStatus({ ...base, budgetExceeded: true })).toBe('ABORTED (budget)');
    expect(runStatus({ ...base, rateLimitedUntil: 5_000 })).toMatch(/^ABORTED \(rate-limited until/);
    expect(runStatus({ ...base, errored: 14 })).toBe('INVALID (>10% errored)');
  });
});

describe('guarded providers (shared gate, pacing, breaker)', () => {
  const mk = (name: string, impl: () => Promise<any[]> = async () => []) => {
    let calls = 0;
    return { calls: () => calls, p: { name, configured: () => true, search: async () => { calls++; return impl(); } } };
  };
  const clock = (t = 1_000) => ({ now: () => t, set: (n: number) => { t = n; } });

  it('shares one gate between a single-target wrapper and a merged-target wrapper', async () => {
    const gate = new RequestGate(2);
    const a = mk('deezer');
    const single = guardProvider(a.p, { gate, breaker: null, gapMs: 0 });
    const merged = guardProvider(a.p, { gate, breaker: null, gapMs: 0 });
    await single.search('q');
    await merged.search('q');
    await expect(single.search('q')).rejects.toBeInstanceOf(BenchThrottled);
    await expect(merged.search('q')).rejects.toMatchObject({ reason: 'budget' });
    expect(a.calls()).toBe(2);
  });

  it('applies the musicbrainz budget inside the merged target', async () => {
    const mb = mk('musicbrainz');
    const g = guardProvider(mb.p, { gate: new RequestGate(budgetFor('musicbrainz', {})), breaker: null, gapMs: 0 });
    for (let i = 0; i < 200; i++) await g.search('q');
    await expect(g.search('q')).rejects.toMatchObject({ reason: 'budget' });
    expect(mb.calls()).toBe(200);
  });

  it('refuses calls inside the pacing gap without touching the network', async () => {
    const c = clock();
    const a = mk('itunes');
    const g = guardProvider(a.p, { gate: new RequestGate(10), breaker: null, gapMs: 3100, now: c.now });
    await g.search('q');
    await expect(g.search('q')).rejects.toMatchObject({ reason: 'pacing' });
    c.set(5_000);
    await g.search('q');
    expect(a.calls()).toBe(2);
  });

  it('does not spend budget on a throttled call', async () => {
    const gate = new RequestGate(5);
    const c = clock();
    const g = guardProvider(mk('itunes').p, { gate, breaker: null, gapMs: 3100, now: c.now });
    await g.search('q');
    await expect(g.search('q')).rejects.toBeInstanceOf(BenchThrottled);
    expect(gate.count).toBe(1);
  });

  it('opens the shared breaker on a 429 and refuses later calls', async () => {
    const recorded: unknown[] = [];
    let until = 0;
    const breaker: Breaker = {
      cooldownUntil: (_n, now = 0) => (until > now ? until : 0),
      recordFailure: (_n, err) => { recorded.push(err); until = 9_999_999; },
    };
    const c = clock();
    const a = mk('spotify', async () => { throw Object.assign(new Error('HTTP 429'), { status: 429 }); });
    const g = guardProvider(a.p, { gate: new RequestGate(10), breaker, gapMs: 0, now: c.now });
    await expect(g.search('q')).rejects.toMatchObject({ status: 429 });
    expect(recorded).toHaveLength(1);
    await expect(g.search('q')).rejects.toMatchObject({ reason: 'breaker' });
    expect(a.calls()).toBe(1);
  });

  it('reports each refusal through onThrottle', async () => {
    const seen: string[] = [];
    const g = guardProvider(mk('deezer').p, { gate: new RequestGate(0), breaker: null, gapMs: 0, onThrottle: (e) => seen.push(e.provider) });
    await expect(g.search('q')).rejects.toBeInstanceOf(BenchThrottled);
    expect(seen).toEqual(['deezer']);
  });
});

describe('daily request counts', () => {
  const mem = () => {
    let text: string | null = null;
    return { read: () => text, write: (t: string) => { text = t; } };
  };
  it('carries today\'s usage into a new run and resets on a new day', () => {
    const store = mem();
    saveDailyCounts(store, '2026-11-01', { spotify: 120 });
    expect(loadDailyCounts(store, '2026-11-01')).toEqual({ spotify: 120 });
    expect(loadDailyCounts(store, '2026-11-02')).toEqual({});
  });
  it('a gate seeded from yesterday-of-today usage runs out sooner', () => {
    const g = new RequestGate(150, 148);
    expect([g.take(), g.take(), g.take()]).toEqual([true, true, false]);
  });
  it('persists on every take', () => {
    const seen: number[] = [];
    const g = new RequestGate(3, 1, (n) => seen.push(n));
    g.take(); g.take(); g.take();
    expect(seen).toEqual([2, 3]);
  });
  it('tolerates a corrupt store and keys by local day', () => {
    expect(loadDailyCounts({ read: () => '{nope', write: () => {} }, 'x')).toEqual({});
    expect(dayKey(new Date(2026, 10, 1, 9, 30))).toBe('2026-11-01');
  });
  it('lets an env override raise a budget', () => {
    expect(budgetFor('spotify', { BENCH_BUDGET_SPOTIFY: '400' })).toBe(400);
    expect(budgetFor('spotify', {})).toBe(150);
  });
});

describe('throttled-by-bench is not degradation', () => {
  it('excludes throttled providers from the INVALID rule', () => {
    const real = degradedSummary(Array.from({ length: 20 }, () => []));
    expect(real.invalid).toEqual([]);
    const throttled = degradedSummary(Array.from({ length: 20 }, () => ['itunes']));
    expect(throttled.text).toBe('itunes:20/20');
  });
});
