import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergedSearch, resetProviderBudgets } from '@/lib/search/merge';
import { musicbrainzLooseQuery } from '@/lib/search/providers/musicbrainz';
import { parseVersion } from '@/lib/search/version';
import type { SearchProvider, SearchResult } from '@/lib/search/types';

// Mock responses modelled on the 2026-11-01 acceptance run (docs/research/search-bench-baseline-2026-11-01-merged.json).
type Name = SearchResult['provider'];

function res(provider: Name, artist: string | string[], title: string, extra: Partial<SearchResult> = {}): SearchResult {
  const artists = Array.isArray(artist) ? artist : [artist];
  return { provider, providerId: `${provider}-${title}-${artists.join('+')}`, artist: artists.join(', '), artists, title, version: parseVersion(title, artists), ...extra };
}

function prov(name: Name, results: SearchResult[]): SearchProvider & { search: ReturnType<typeof vi.fn> } {
  return { name, configured: () => true, search: vi.fn(async () => results) };
}

beforeAll(() => {
  process.env.SETARCHITECT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'followups-test-'));
});
afterEach(() => resetProviderBudgets());

describe('search follow-ups (Phase 2 memo section 5)', () => {
  it('Solardo "Deeper Love": asks MusicBrainz when only another act\'s "Deeper Love" came back, and ranks Solardo first', async () => {
    const mb = prov('musicbrainz', [res('musicbrainz', 'Solardo', 'Deeper Love', { durationMs: 151_000 })]);
    const { hits } = await mergedSearch('Solardo Deeper Love', {
      providers: [
        prov('deezer', [
          res('deezer', 'Steen Thottrup', 'Deeper Love (Radio Edit)', { durationMs: 161_000 }),
          res('deezer', 'Steen Thottrup', 'Deeper Love (Extended Mix)', { durationMs: 302_000 }),
          res('deezer', 'Steen Thottrup', 'Deeper Love (Calmabohain Remix)', { durationMs: 202_000 }),
        ]),
        mb,
      ],
    });
    expect(mb.search).toHaveBeenCalledOnce();
    expect(hits[0].artist).toBe('Solardo');
  });

  it('Kölsch "Speicher 140": never puts another Kölsch track first once the real one is found', async () => {
    const mb = prov('musicbrainz', [res('musicbrainz', 'Kölsch', 'Speicher 140', { durationMs: 380_000 })]);
    const { hits } = await mergedSearch('Kölsch Speicher 140', {
      providers: [
        prov('spotify', [res('spotify', 'Kölsch', 'Anti Promi Energie', { durationMs: 303_348 }), res('spotify', 'Kölsch', 'Get Lost', { durationMs: 274_804 })]),
        prov('deezer', [res('deezer', 'Kölsch', 'Anti Promi Energie', { durationMs: 303_000 }), res('deezer', 'Kölsch', 'Verschwinden', { durationMs: 298_785 })]),
        mb,
      ],
    });
    expect(hits[0].baseTitle).toBe('Speicher 140');
  });

  it('Fisher "Rain" extended: a co-credit 76% longer than Fisher\'s own "Rain" is demoted and MusicBrainz supplies the real extended', async () => {
    const mb = prov('musicbrainz', [res('musicbrainz', 'Fisher', 'Rain (Extended Mix)', { durationMs: 266_793 })]);
    const { hits } = await mergedSearch('Fisher Rain Extended Mix', {
      providers: [
        prov('spotify', [
          res('spotify', ['Karanda', 'Fisher'], 'Rain - Extended Mix', { durationMs: 367_500 }),
          res('spotify', 'FISHER', 'Rain', { durationMs: 208_640 }),
        ]),
        mb,
      ],
    });
    expect(mb.search).toHaveBeenCalledOnce();
    expect(hits[0]).toMatchObject({ artist: 'Fisher', durationMs: 266_793 });
    expect(hits.findIndex((h) => h.artist.includes('Karanda'))).toBeGreaterThan(0);
  });

  it('does not demote a co-credit when the queried act has no own recording of that title', async () => {
    const { hits } = await mergedSearch('Elderbrook Cola', {
      providers: [prov('spotify', [res('spotify', ['CamelPhat', 'Elderbrook'], 'Cola', { durationMs: 220_000 })])],
    });
    expect(hits[0].artist).toBe('CamelPhat, Elderbrook');
  });

  it('"Disclosure Latch Joel Fletcher Remix": ranks the remix above unrelated "Disclosure" titles', async () => {
    const mb = prov('musicbrainz', [res('musicbrainz', ['Disclosure', 'Sam Smith'], 'Latch (Joel Fletcher remix)', { durationMs: 230_000 })]);
    const { hits } = await mergedSearch('Disclosure Latch Joel Fletcher Remix', {
      providers: [
        prov('spotify', [
          res('spotify', 'P41', 'Disclosure', { durationMs: 194_304 }),
          res('spotify', 'Cam Patterson', 'Disclosure', { durationMs: 212_625 }),
          res('spotify', 'Emoh Rekerdz', 'Disclosure', { durationMs: 76_617 }),
        ]),
        mb,
      ],
    });
    expect(hits[0].version).toMatchObject({ baseTitle: 'Latch', kind: 'remix', remixer: 'Joel Fletcher' });
  });

  it('builds a loose MusicBrainz query from content words, version words only boosting', () => {
    expect(musicbrainzLooseQuery(['disclosure', 'latch', 'remix'])).toBe('recording:(disclosure latch) artist:(disclosure latch) recording:(remix)^10');
  });
});
