import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergedSearch, PROVIDER_TIMEOUT_MS, PROVIDER_TIMEOUTS, providerQuery, resetProviderBudgets, uniqueKeys } from '@/lib/search/merge';
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
    expect(PROVIDER_TIMEOUTS.musicbrainz).toBe(2500);
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

  it('gives MusicBrainz 2.5s by default while the others keep 1.2s', async () => {
    vi.useFakeTimers();
    const mb = prov('musicbrainz' as Name, () => new Promise((r) => setTimeout(() => r([res('musicbrainz', 'CamelPhat', 'Cola (radio edit)')]), 2000)));
    const p = mergedSearch('camelphat cola radio edit', { providers: [prov('spotify', [res('spotify', 'CamelPhat', 'Cola')]), mb] });
    await vi.advanceTimersByTimeAsync(2100);
    const out = await p;
    expect(out.degraded).toEqual([]);
    expect(out.hits.some((h) => h.version.kind === 'radio')).toBe(true);
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

describe('mergedSearch: MusicBrainz version discovery', () => {
  const mbProv = (results: SearchResult[]) => prov('musicbrainz' as Name, results);

  it('is not asked when the first round fully answers the query', async () => {
    const mb = mbProv([]);
    await mergedSearch('camelphat cola', { providers: [prov('spotify', [res('spotify', 'CamelPhat', 'Cola')]), mb] });
    expect(mb.search).not.toHaveBeenCalled();
  });

  it('is not asked when no work was identified (half-typed query)', async () => {
    const mb = mbProv([]);
    await mergedSearch('cola cam', { providers: [prov('spotify', [res('spotify', 'Someone', 'Colab')]), mb] });
    expect(mb.search).not.toHaveBeenCalled();
  });

  it('finds an asked version the streaming catalogs lack, via a work query with a version boost', async () => {
    const mb = mbProv([
      res('musicbrainz', 'Disclosure', 'Latch', { durationMs: 256_000 }),
      res('musicbrainz', 'Disclosure', 'Latch (Extended Version)', { durationMs: 257_000 }),
    ]);
    const { hits } = await mergedSearch('Disclosure Latch Extended Version', {
      providers: [prov('spotify', [res('spotify', ['Disclosure', 'Sam Smith'], 'Latch', { durationMs: 256_000, spotifyId: 's' })]), mb],
    });
    expect(mb.search).toHaveBeenCalledWith('+recording:"Latch" +artist:"Disclosure" recording:(extended version)^10');
    expect(hits[0]).toMatchObject({ baseTitle: 'Latch', providers: ['musicbrainz'] });
    expect(hits[0].version.kind).toBe('extended');
    // the MusicBrainz copy of the original merges with Spotify's
    expect(hits.find((h) => h.version.kind === 'original')?.providers).toEqual(['spotify', 'musicbrainz']);
  });

  it('merges a MusicBrainz recording with a streaming hit of the same version and length', async () => {
    const { hits } = await mergedSearch('meduza piece of your heart extended', {
      providers: [
        prov('deezer', [res('deezer', 'MEDUZA', 'Piece Of Your Heart', { isrc: 'DEUM1' })]),
        prov('itunes', [res('itunes', 'MEDUZA & Goodboys', 'Piece of Your Heart (Extended Mix)', { durationMs: 427_000 })]),
        mbProv([res('musicbrainz', 'Meduza', 'Piece of Your Heart (extended)', { isrc: 'DEUM2', durationMs: 427_741 })]),
      ],
    });
    const ext = hits.filter((h) => h.version.kind === 'extended');
    expect(ext).toHaveLength(1);
    expect(ext[0].providers).toEqual(['itunes', 'musicbrainz']);
  });

  it('ranks a catalog-only recording below a streamable one of the same version', async () => {
    const { hits } = await mergedSearch('zedd clarity radio edit', {
      providers: [
        prov('spotify', [res('spotify', 'Zedd', 'Clarity')]),
        prov('itunes', [res('itunes', 'Zedd', 'Clarity (Radio Edit)', { durationMs: 265_000 })]),
        mbProv([res('musicbrainz', 'Zedd', 'Clarity (radio edit)', { durationMs: 229_000 })]),
      ],
    });
    const radios = hits.filter((h) => h.version.kind === 'radio');
    expect(radios.map((h) => h.providers)).toEqual([['itunes'], ['musicbrainz']]);
  });
});

describe('mergedSearch: review fix round 1', () => {
  it('I1: never merges a different artist whose name is a substring, in either provider order', async () => {
    const a = res('spotify', 'Elle King', 'Ex', { durationMs: 200_000 });
    const b = res('deezer', 'Elle', 'Ex', { durationMs: 200_000 });
    for (const providers of [[prov('spotify', [a]), prov('deezer', [b])], [prov('deezer', [b]), prov('spotify', [a])]]) {
      const { hits } = await mergedSearch('ex', { providers });
      expect(hits).toHaveLength(2);
    }
    const kygo = await mergedSearch('firestone', {
      providers: [prov('spotify', [res('spotify', 'Kygo Tribute', 'Firestone')]), prov('deezer', [res('deezer', 'Kygo', 'Firestone')])],
    });
    expect(kygo.hits).toHaveLength(2);
  });

  it('I1: still merges the same credit written with different separators', async () => {
    const { hits } = await mergedSearch('x track', {
      providers: [prov('spotify', [res('spotify', 'Mark Knight', 'Track')]), prov('deezer', [res('deezer', 'Mark, Knight', 'Track')])],
    });
    expect(hits).toHaveLength(1);
  });

  it('I2: "X Extended Remix" and "X Remix" stay apart even without durations (R5)', async () => {
    const { hits } = await mergedSearch('cola artbat remix', {
      providers: [
        prov('spotify', [res('spotify', 'CamelPhat', 'Cola - ARTBAT Remix')]),
        prov('deezer', [res('deezer', 'CamelPhat', 'Cola (ARTBAT Extended Remix)')]),
      ],
    });
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.key)).size).toBe(2);
  });

  it('I2: two different ISRCs never merge, whatever the titles say', async () => {
    const { hits } = await mergedSearch('camelphat cola', {
      providers: [
        prov('spotify', [res('spotify', 'CamelPhat', 'Cola', { isrc: 'GB1' })]),
        prov('deezer', [res('deezer', 'CamelPhat', 'Cola', { isrc: 'GB2' })]),
      ],
    });
    expect(hits.map((h) => h.key).sort()).toEqual(['GB1', 'GB2']);
  });

  it('I3: recordings split only by duration get distinct, stable keys', async () => {
    const run = () =>
      mergedSearch('camelphat cola', {
        providers: [
          prov('spotify', [res('spotify', 'CamelPhat', 'Cola', { durationMs: 190_000 })]),
          prov('deezer', [res('deezer', 'CamelPhat', 'Cola', { durationMs: 420_000 })]),
        ],
      });
    const first = (await run()).hits.map((h) => h.key);
    expect(new Set(first).size).toBe(2);
    expect((await run()).hits.map((h) => h.key)).toEqual(first);
  });

  it('I3: any remaining key collision is suffixed', () => {
    const h = (key: string) => ({ key, artist: 'A', baseTitle: 'S', version: { baseTitle: 'S', kind: 'original' as const, featuring: [] }, providers: [], score: 0 });
    expect(uniqueKeys([h('k'), h('j'), h('k'), h('k')]).map((x) => x.key)).toEqual(['k', 'j', 'k#2', 'k#3']);
  });

  it('prefers the label-less form when two providers describe the same original', async () => {
    const { hits } = await mergedSearch('cola', {
      providers: [
        prov('spotify', [res('spotify', 'CamelPhat', 'Cola - Original Mix', { isrc: 'GB1' })]),
        prov('deezer', [res('deezer', 'CamelPhat', 'Cola', { isrc: 'GB1' })]),
      ],
    });
    expect(hits[0].version.label).toBeUndefined();
  });

  it('does not ask a provider again in round two after it hung in round one', async () => {
    const hung = prov('spotify', () => new Promise(() => {}));
    const t0 = Date.now();
    await mergedSearch('CamelPhat Cola ZHU Remix', {
      timeoutMs: 40,
      providers: [hung, prov('deezer', [res('deezer', 'CamelPhat', 'Cola')])],
    });
    expect(hung.search).toHaveBeenCalledTimes(1);
    expect(Date.now() - t0).toBeLessThan(80);
  });
});

describe('mergedSearch: review fix round 2', () => {
  const mb = (artist: string | string[], title: string, extra: Partial<SearchResult> & { isrcs?: string[] } = {}) =>
    res('musicbrainz', artist, title, extra as Partial<SearchResult>);
  const mbProv = (results: SearchResult[]) => prov('musicbrainz' as Name, results);
  // "goodboys" is not in Deezer's credit, so round one is not a full answer and MusicBrainz is asked
  const q = 'meduza piece of your heart extended goodboys';
  const dz = () => prov('deezer', [res('deezer', 'MEDUZA', 'Piece Of Your Heart (Extended Mix)', { isrc: 'DEUM71900663', durationMs: 427_000 })]);
  const extOf = (hits: Array<{ version: { kind: string } }>) => hits.filter((h) => h.version.kind === 'extended');

  it('I1: merges by ANY of MusicBrainz\'s ISRCs, not just the first', async () => {
    const { hits } = await mergedSearch(q, { providers: [dz(), mbProv([mb('Meduza', 'Piece of Your Heart (extended)', { isrc: 'GBXXX0000001', isrcs: ['GBXXX0000001', 'DEUM71900663'], durationMs: 300_000 })])] });
    const ext = extOf(hits);
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({ key: 'DEUM71900663', providers: ['deezer', 'musicbrainz'] });
  });

  it('I1: a MusicBrainz ISRC from another release never creates a duplicate catalog-only row', async () => {
    const { hits } = await mergedSearch(q, { providers: [dz(), mbProv([mb('Meduza', 'Piece of Your Heart (extended)', { isrc: 'GBXXX0000001', isrcs: ['GBXXX0000001'], durationMs: 427_741 })])] });
    expect(extOf(hits)).toHaveLength(1);
  });

  it('I1: an MB-only group duplicating a streamable version is dropped', async () => {
    const { hits } = await mergedSearch('disclosure latch extended', {
      providers: [
        prov('deezer', [res('deezer', 'Disclosure', 'Latch', { isrc: 'GBUM1', durationMs: 256_000 })]),
        mbProv([mb('Disclosure', 'Latch', { isrc: 'OTHER1', durationMs: 250_000 }), mb('Disclosure', 'Latch', { isrc: 'OTHER2' })]),
      ],
    });
    expect(hits.filter((h) => h.version.kind === 'original')).toHaveLength(1);
  });

  it('R14: different streaming ISRCs merge only for a same-lead re-release of identical version and length (±2s)', async () => {
    const two = (b: Partial<SearchResult>, title2 = 'Cola') =>
      mergedSearch('camelphat cola', {
        providers: [
          prov('spotify', [res('spotify', 'CamelPhat', 'Cola', { isrc: 'GB1', durationMs: 200_000 })]),
          prov('deezer', [res('deezer', 'CamelPhat', title2, { isrc: 'GB2', ...b })]),
        ],
      });
    expect((await two({ durationMs: 201_500 })).hits).toHaveLength(1);
    expect((await two({ durationMs: 203_000 })).hits).toHaveLength(2);
    expect((await two({})).hits).toHaveLength(2);
    expect((await two({ durationMs: 200_000 }, 'Cola (Extended Mix)')).hits).toHaveLength(2);
  });

  it('minor 5: an "&" act never merges with a lone act named like one of its parts unless lengths match', async () => {
    const run = (a: Partial<SearchResult>, b: Partial<SearchResult>) =>
      mergedSearch('sun', { providers: [prov('deezer', [res('deezer', 'Above & Beyond', 'Sun', a)]), prov('itunes', [res('itunes', 'Beyond', 'Sun', b)])] });
    expect((await run({}, {})).hits).toHaveLength(2);
    expect((await run({ durationMs: 200_000 }, { durationMs: 260_000 })).hits).toHaveLength(2);
    // a collaboration credited to its lead on one catalog still dedups when the lengths agree
    const collab = await mergedSearch('cola', {
      providers: [prov('deezer', [res('deezer', 'CamelPhat', 'Cola', { durationMs: 224_000 })]), prov('itunes', [res('itunes', 'CamelPhat & Elderbrook', 'Cola', { durationMs: 224_500 })])],
    });
    expect(collab.hits).toHaveLength(1);
  });

  it('minor 4: MusicBrainz is asked for the group\'s first credited artist, whole', async () => {
    const m = mbProv([]);
    await mergedSearch('tyler the creator earfquake radio edit', {
      providers: [prov('spotify', [res('spotify', ['Tyler, The Creator', 'Playboi Carti'], 'EARFQUAKE')]), m],
    });
    expect(m.search.mock.calls[0][0]).toContain('+artist:"Tyler, The Creator"');
  });

  it('minor 6: the key\'s length bucket is 10s on the shortest length, stable when a provider is missing', async () => {
    const keyOf = async (providers: SearchProvider[]) => (await mergedSearch('camelphat cola', { providers })).hits[0].key;
    const sp = () => prov('spotify', [res('spotify', 'CamelPhat', 'Cola', { durationMs: 190_400 })]);
    const dzr = () => prov('deezer', [res('deezer', 'CamelPhat', 'Cola', { durationMs: 191_600 })]);
    const both = await keyOf([sp(), dzr()]);
    expect(both).toMatch(/\|d190$/);
    expect(await keyOf([dzr()])).toBe(both);
  });

  it('minor 7: a provider set with only second-round providers asks them the plain query', async () => {
    const m = mbProv([mb('CamelPhat', 'Cola')]);
    const { hits } = await mergedSearch('camelphat cola', { providers: [m] });
    expect(m.search).toHaveBeenCalledWith('camelphat cola');
    expect(hits).toHaveLength(1);
  });
});
