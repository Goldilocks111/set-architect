import { describe, expect, it } from 'vitest';
import {
  REQUEST_BUDGET,
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
