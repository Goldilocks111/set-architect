import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureMusicBrainzLimiter, musicbrainzAdapter, MUSICBRAINZ_UA } from '@/lib/sources/musicbrainz';
import { base, json, mockFetch } from './helpers';

beforeEach(() => configureMusicBrainzLimiter(0));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('musicbrainzAdapter', () => {
  it('takes length (ms) from the accepted ISRC recording', async () => {
    mockFetch([['/isrc/ISRC1', () => json({ recordings: [{ id: 'mbid-1', title: 'One More Time', length: 320000 }] })]]);
    expect(await musicbrainzAdapter.enrich(base({ isrc: 'ISRC1' }))).toEqual({ mbid: 'mbid-1', durationMs: 320000 });
  });
  it('takes length from the accepted search recording, not a low-score one', async () => {
    mockFetch([['/recording?', () => json({ recordings: [{ id: 'low', score: 80, length: 1000 }, { id: 'good', score: 95, title: 'One More Time', length: 241000 }] })]]);
    expect(await musicbrainzAdapter.enrich(base())).toEqual({ mbid: 'good', durationMs: 241000 });
  });
  it('does not take a length from a recording whose title does not match', async () => {
    mockFetch([['/recording?', () => json({ recordings: [{ id: 'x', score: 100, title: 'Different Song', length: 99000 }] })]]);
    expect(await musicbrainzAdapter.enrich(base())).toEqual({ mbid: 'x' });
  });
  it('omits durationMs when the recording has no length', async () => {
    mockFetch([['/recording?', () => json({ recordings: [{ id: 'x', score: 100 }] })]]);
    expect(await musicbrainzAdapter.enrich(base())).toEqual({ mbid: 'x' });
  });
  it('maps an ISRC to the first recording mbid and sends the descriptive User-Agent', async () => {
    const fetchFn = mockFetch([['/isrc/ISRC1', () => json({ isrc: 'ISRC1', recordings: [{ id: 'mbid-1' }, { id: 'mbid-2' }] })]]);
    const out = await musicbrainzAdapter.enrich(base({ isrc: 'ISRC1' }));
    expect(out).toEqual({ mbid: 'mbid-1' });
    const init = (fetchFn.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(MUSICBRAINZ_UA);
    expect(MUSICBRAINZ_UA).toContain('SetArchitect/0.1');
  });

  it('falls back to recording search when there is no ISRC, accepting score >= 90 only', async () => {
    mockFetch([['/recording?', () => json({ recordings: [{ id: 'low', score: 80 }, { id: 'good', score: 95 }] })]]);
    expect(await musicbrainzAdapter.enrich(base())).toEqual({ mbid: 'good' });
    mockFetch([['/recording?', () => json({ recordings: [{ id: 'low', score: 89 }] })]]);
    expect(await musicbrainzAdapter.enrich(base())).toEqual({});
  });

  it('falls back to search when the ISRC is unknown (404)', async () => {
    mockFetch([
      ['/isrc/', () => json({ error: 'nf' }, 404)],
      ['/recording?', () => json({ recordings: [{ id: 'found', score: 100 }] })],
    ]);
    expect(await musicbrainzAdapter.enrich(base({ isrc: 'X' }))).toEqual({ mbid: 'found' });
  });

  it('spaces requests at least one gap apart', async () => {
    vi.useFakeTimers();
    configureMusicBrainzLimiter(200);
    const times: number[] = [];
    mockFetch([['/isrc/', () => (times.push(Date.now()), json({ recordings: [{ id: 'm' }] }))]]);
    const both = Promise.all([musicbrainzAdapter.enrich(base({ isrc: 'A' })), musicbrainzAdapter.enrich(base({ isrc: 'B' }))]);
    await vi.advanceTimersByTimeAsync(199);
    expect(times).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await both;
    expect(times[1] - times[0]).toBe(200);
    vi.useRealTimers();
  });

  it('skips when an mbid is already known', async () => {
    const f = mockFetch([]);
    expect(await musicbrainzAdapter.enrich(base({ mbid: 'm' }))).toEqual({});
    expect(f).not.toHaveBeenCalled();
  });
});
