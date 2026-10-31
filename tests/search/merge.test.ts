import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergedSearch, PROVIDER_TIMEOUT_MS, providerQuery, resetProviderBudgets } from '@/lib/search/merge';
import { THROTTLE_COOLDOWN_MS } from '@/lib/search/breaker';
import { parseVersion } from '@/lib/search/version';
import { HttpError } from '@/lib/http';
import type { SearchProvider, SearchResult } from '@/lib/search/types';

type Name = SearchResult['provider'];

function res(provider: Name, artist: string | string[], title: string, extra: Partial<SearchResult> = {}): SearchResult {
  const artists = Array.isArray(artist) ? artist : [artist];
  return {
    provider,
    providerId: `${provider}-${title}-${artists.join('+')}`,
    artist: artists.join(', '),
    artists,
    title,
    version: parseVersion(title, artists),
    ...extra,
  };
}

function prov(name: Name, results: SearchResult[] | (() => Promise<SearchResult[]>)): SearchProvider & { search: ReturnType<typeof vi.fn> } {
  return {
    name,
    configured: () => true,
    search: vi.fn(typeof results === 'function' ? results : async () => results),
  };
}

const labels = (hits: Array<{ version: { label?: string } }>) => hits.map((h) => h.version.label ?? '');

beforeAll(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-test-'));
});

afterEach(() => {
  vi.useRealTimers();
  resetProviderBudgets();
});

describe('mergedSearch: version distinctness (review focus 1)', () => {
  it('never merges an extended mix with a named remix', async () => {
    const { hits } = await mergedSearch('camelphat cola', {
      providers: [
        prov('spotify', [res('spotify', 'CamelPhat', 'Cola - Extended Mix', { durationMs: 400_000 })]),
        prov('deezer', [res('deezer', 'CamelPhat', 'Cola (Mark Knight Remix)', { durationMs: 400_000 })]),
      ],
    });
    expect(hits).toHaveLength(2);
    expect(labels(hits).sort()).toEqual(['Extended Mix', 'Mark Knight Remix']);
  });

  it('keeps "X Remix" and "X Remix, Extended" as different recordings (R5)', async () => {
    const { hits } = await mergedSearch('opus four tet remix', {
      providers: [
        prov('spotify', [res('spotify', 'Eric Prydz', 'Opus - Four Tet Remix')]),
        prov('itunes', [res('itunes', 'Eric Prydz', 'Opus (Four Tet Remix) [Extended]')]),
      ],
    });
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.key)).size).toBe(2);
  });

  it('merges the same remix spelled differently across providers', async () => {
    const { hits } = await mergedSearch('cola mark knight remix', {
      providers: [
        prov('spotify', [res('spotify', 'CamelPhat', 'Cola - Mark Knight Remix')]),
        prov('itunes', [res('itunes', 'CamelPhat', 'Cola (Mark Knight Remix)')]),
      ],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].providers).toEqual(['spotify', 'itunes']);
    expect(hits[0].version.remixer).toBe('Mark Knight');
  });

  it('keeps two unlabeled recordings apart when their durations clearly differ', async () => {
    const { hits } = await mergedSearch('artist track', {
      providers: [
        prov('spotify', [res('spotify', 'Artist', 'Track', { durationMs: 180_000 })]),
        prov('deezer', [res('deezer', 'Artist', 'Track', { durationMs: 420_000 })]),
      ],
    });
    expect(hits).toHaveLength(2);
  });
});

describe('mergedSearch: featured artists (review focus 2)', () => {
  it('dedups "feat." titles and combined artist strings into one hit', async () => {
    // A title-only query is not a full answer, so iTunes is asked too.
    const { hits } = await mergedSearch('cola', {
      providers: [
        prov('spotify', [res('spotify', ['CamelPhat', 'Elderbrook'], 'Cola')]),
        prov('deezer', [res('deezer', 'CamelPhat', 'Cola (feat. Elderbrook)')]),
        prov('itunes', [res('itunes', 'CamelPhat & Elderbrook', 'Cola')]),
      ],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].baseTitle).toBe('Cola');
    expect(hits[0].providers).toHaveLength(3);
  });

  it('ranks the exact match first when the query carries "ft."', async () => {
    const { hits } = await mergedSearch('cola ft elderbrook camelphat', {
      providers: [
        prov('deezer', [
          res('deezer', 'Someone Else', 'Elderbrook Dreams', { popularity: 99 }),
          res('deezer', 'CamelPhat', 'Cola (feat. Elderbrook)', { popularity: 40 }),
        ]),
      ],
    });
    expect(hits[0].artist).toBe('CamelPhat');
  });
});

describe('mergedSearch: accents (review focus 3)', () => {
  it('matches accented artists from a plain-ASCII query', async () => {
    const { hits } = await mergedSearch('ben bohmer breathing', {
      providers: [
        prov('deezer', [
          res('deezer', 'Benny Bohm', 'Breath', { popularity: 90 }),
          res('deezer', 'Ben Böhmer', 'Breathing', { popularity: 50 }),
        ]),
      ],
    });
    expect(hits[0].artist).toBe('Ben Böhmer');
  });

  it('dedups "Rüfüs Du Sol" with "RÜFÜS DU SOL" and handles ø', async () => {
    const { hits } = await mergedSearch('rufus du sol innerbloom', {
      providers: [
        prov('spotify', [res('spotify', 'RÜFÜS DU SOL', 'Innerbloom')]),
        prov('itunes', [res('itunes', 'Rüfüs Du Sol', 'Innerbloom')]),
      ],
    });
    expect(hits).toHaveLength(1);
    const r = await mergedSearch('royksopp eple', {
      providers: [prov('deezer', [res('deezer', 'Other', 'Apple'), res('deezer', 'Röyksopp', 'Eple')])],
    });
    expect(r.hits[0].artist).toBe('Röyksopp');
  });
});

describe('mergedSearch: degradation (review focus 4)', () => {
  it('a provider that times out is reported as degraded, the rest still answer', async () => {
    const { hits, degraded } = await mergedSearch('cola', {
      timeoutMs: 30,
      providers: [
        prov('spotify', [res('spotify', 'CamelPhat', 'Cola')]),
        prov('itunes', () => new Promise(() => {})),
      ],
    });
    expect(degraded).toEqual(['itunes']);
    expect(hits).toHaveLength(1);
  });

  it('a provider that throws is degraded, not fatal', async () => {
    const { hits, degraded } = await mergedSearch('cola', {
      providers: [
        prov('spotify', async () => {
          throw new Error('500');
        }),
        prov('deezer', [res('deezer', 'CamelPhat', 'Cola')]),
      ],
    });
    expect(degraded).toEqual(['spotify']);
    expect(hits).toHaveLength(1);
  });

  it('uses a 1.2s per-provider timeout by default', async () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(1200);
    vi.useFakeTimers();
    const p = mergedSearch('cola', {
      providers: [prov('spotify', () => new Promise(() => {})), prov('deezer', [res('deezer', 'CamelPhat', 'Cola')])],
    });
    let settled = false;
    p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect((await p).degraded).toEqual(['spotify']);
  });

  it('skips providers that are not configured without degrading', async () => {
    const off = { ...prov('spotify', []), configured: () => false };
    const { degraded } = await mergedSearch('cola', { providers: [off, prov('deezer', [])] });
    expect(off.search).not.toHaveBeenCalled();
    expect(degraded).toEqual([]);
  });
});

describe('mergedSearch: ISRC (review focus 5)', () => {
  it('merges the same ISRC across "Original Mix" and plain titles', async () => {
    const { hits } = await mergedSearch('cola', {
      providers: [
        prov('spotify', [res('spotify', 'CamelPhat', 'Cola - Original Mix', { isrc: 'GBX1', spotifyId: 'sp1' })]),
        prov('deezer', [res('deezer', 'CamelPhat', 'Cola', { isrc: 'GBX1', popularity: 70 })]),
      ],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ key: 'GBX1', isrc: 'GBX1', spotifyId: 'sp1', popularity: 70, providers: ['spotify', 'deezer'] });
    expect(hits[0].version.kind).toBe('original');
  });

  it('ISRC wins over title differences and keeps the more specific version', async () => {
    const { hits } = await mergedSearch('cola', {
      providers: [
        prov('spotify', [res('spotify', 'CamelPhat', 'Cola - Extended Mix', { isrc: 'GBX2' })]),
        prov('deezer', [res('deezer', 'CamelPhat', 'Cola', { isrc: 'GBX2' })]),
      ],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].version.label).toBe('Extended Mix');
  });
});

describe('mergedSearch: ranking', () => {
  it('exact artist+title beats a more popular partial match', async () => {
    const { hits } = await mergedSearch('lane 8 brightest lights', {
      providers: [
        prov('deezer', [
          res('deezer', 'Lane 8', 'Lights', { popularity: 100 }),
          res('deezer', 'Lane 8', 'Brightest Lights', { popularity: 20 }),
        ]),
      ],
    });
    expect(hits[0].baseTitle).toBe('Brightest Lights');
  });

  it('popularity breaks ties between exact matches, then recency', async () => {
    const pop = await mergedSearch('a song', {
      providers: [
        prov('deezer', [
          res('deezer', 'A', 'Song', { popularity: 10, durationMs: 100_000 }),
          res('deezer', 'A', 'Song', { popularity: 90, durationMs: 300_000 }),
        ]),
      ],
    });
    expect(pop.hits[0].popularity).toBe(90);
    const rec = await mergedSearch('a song', {
      providers: [
        prov('spotify', [res('spotify', 'A', 'Song', { releaseDate: '2001-01-01', durationMs: 100_000 })]),
        prov('deezer', [res('deezer', 'A', 'Song', { releaseDate: '2025-01-01', durationMs: 300_000 })]),
      ],
    });
    expect(rec.hits[0].releaseDate).toBe('2025-01-01');
  });

  it('boosts the version the query asks for', async () => {
    const { hits } = await mergedSearch('camelphat cola mark knight remix', {
      providers: [
        prov('spotify', [
          res('spotify', 'CamelPhat', 'Cola'),
          res('spotify', 'CamelPhat', 'Cola - Extended Mix'),
          res('spotify', 'CamelPhat', 'Cola - Mark Knight Remix'),
        ]),
      ],
    });
    expect(hits[0].version.remixer).toBe('Mark Knight');
    const ext = await mergedSearch('camelphat cola extended mix', {
      providers: [prov('spotify', [res('spotify', 'CamelPhat', 'Cola'), res('spotify', 'CamelPhat', 'Cola - Extended Mix')])],
    });
    expect(ext.hits[0].version.kind).toBe('extended');
  });

  it('prefers the original when the query names no version', async () => {
    const { hits } = await mergedSearch('camelphat cola', {
      providers: [
        prov('spotify', [res('spotify', 'CamelPhat', 'Cola - Mark Knight Remix'), res('spotify', 'CamelPhat', 'Cola')]),
      ],
    });
    expect(hits[0].version.kind).toBe('original');
  });

  it('keeps versions of the same work adjacent', async () => {
    const { hits } = await mergedSearch('camelphat cola', {
      providers: [
        prov('spotify', [
          res('spotify', 'CamelPhat', 'Cola'),
          res('spotify', 'CamelPhat', 'Panic Room'),
          res('spotify', 'CamelPhat', 'Cola - Extended Mix'),
        ]),
      ],
    });
    expect(hits.map((h) => h.baseTitle)).toEqual(['Cola', 'Cola', 'Panic Room']);
  });

  it('returns scores in a contract-shaped response', async () => {
    const r = await mergedSearch('x', { providers: [] });
    expect(r).toEqual({ hits: [], degraded: [] });
  });
});

describe('mergedSearch: provider etiquette and query shaping', () => {
  it('sends Deezer the query without a trailing version qualifier', async () => {
    expect(providerQuery('deezer', 'CamelPhat Cola Radio Edit')).toBe('CamelPhat Cola');
    expect(providerQuery('deezer', 'Disclosure Latch Joel Fletcher Remix')).toBe('Disclosure Latch Joel Fletcher');
    expect(providerQuery('deezer', 'Queen Radio Ga Ga')).toBe('Queen Radio Ga Ga');
    expect(providerQuery('deezer', 'Original Mix')).toBe('Original Mix');
    expect(providerQuery('spotify', 'CamelPhat Cola Radio Edit')).toBe('CamelPhat Cola Radio Edit');
    const dz = prov('deezer', []);
    await mergedSearch('CamelPhat Cola Extended Mix', { providers: [dz] });
    expect(dz.search).toHaveBeenCalledWith('CamelPhat Cola');
  });

  it('stops calling iTunes after 20 requests a minute and reports it degraded', async () => {
    const it = prov('itunes', []);
    for (let i = 0; i < 20; i++) expect((await mergedSearch('q', { providers: [it] })).degraded).toEqual([]);
    expect((await mergedSearch('q', { providers: [it] })).degraded).toEqual(['itunes']);
    expect(it.search).toHaveBeenCalledTimes(20);
  });

  it('asks rate-limited iTunes only when Spotify and Deezer give no full answer', async () => {
    const it1 = prov('itunes', [res('itunes', 'CamelPhat', 'Cola (Radio Edit)')]);
    const sp = prov('spotify', [res('spotify', 'CamelPhat', 'Cola')]);
    const full = await mergedSearch('camelphat cola', { providers: [sp, it1] });
    expect(it1.search).not.toHaveBeenCalled();
    expect(full.hits).toHaveLength(1);
    const radio = await mergedSearch('camelphat cola radio edit', { providers: [sp, it1] });
    expect(it1.search).toHaveBeenCalledWith('camelphat cola radio edit');
    expect(radio.hits[0].version.kind).toBe('radio');
  });

  it('retries with the identified work plus the leftover words when the asked version is missing', async () => {
    const sp = prov('spotify', async () => []);
    sp.search.mockImplementation(async (q: string) =>
      q === 'Cola ZHU Remix'
        ? [res('spotify', ['CamelPhat', 'ZHU'], 'Cola - ZHU Remix')]
        : [res('spotify', ['CamelPhat', 'Elderbrook'], 'Cola'), res('spotify', ['CamelPhat', 'Elderbrook', 'ARTBAT'], 'Cola - ARTBAT Remix')]
    );
    const { hits } = await mergedSearch('CamelPhat Elderbrook Cola ZHU Remix', { providers: [sp] });
    expect(sp.search.mock.calls.map((c) => c[0])).toEqual(['CamelPhat Elderbrook Cola ZHU Remix', 'Cola ZHU Remix']);
    expect(hits[0].version.remixer).toBe('ZHU');
  });

  it('stops calling a provider that answered 429 until the cooldown passes', async () => {
    vi.useFakeTimers();
    const sp = prov('spotify', async () => {
      throw new HttpError(429, 'x');
    });
    const dz = prov('deezer', [res('deezer', 'CamelPhat', 'Cola')]);
    expect((await mergedSearch('camelphat cola', { providers: [sp, dz] })).degraded).toEqual(['spotify']);
    expect((await mergedSearch('camelphat cola', { providers: [sp, dz] })).degraded).toEqual(['spotify']);
    expect(sp.search).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(THROTTLE_COOLDOWN_MS + 1);
    await mergedSearch('camelphat cola', { providers: [sp, dz] });
    expect(sp.search).toHaveBeenCalledTimes(2);
  });

  it('SEARCH_PROVIDERS restricts the default provider set', async () => {
    vi.stubEnv('SEARCH_PROVIDERS', 'nobody');
    expect(await mergedSearch('cola')).toEqual({ hits: [], degraded: [] });
    vi.unstubAllEnvs();
  });

  it('drops soundtrack source tags from the base title', async () => {
    const { hits } = await mergedSearch('justice pusher', {
      providers: [prov('spotify', [res('spotify', ['Justice', 'Gesaffelstein'], 'Pusher [From GTAVI: Original Score]')])],
    });
    expect(hits[0].baseTitle).toBe('Pusher');
  });
});
