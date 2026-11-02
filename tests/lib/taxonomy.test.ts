import { describe, expect, it } from 'vitest';
import { LANES, laneOfTag, lanesFromTags, type Lane } from '@/lib/style/taxonomy';

const one = (name: string) => lanesFromTags([{ name, count: 100 }]);

describe('taxonomy aliases', () => {
  const cases: Array<[string, Lane]> = [
    ['melodic techno', 'melodic-techno'],
    ['Melodic-Techno', 'melodic-techno'],
    ['MELODIC TECHNO', 'melodic-techno'],
    ['afterlife', 'melodic-techno'],
    ['nu disco', 'disco-nu-disco'],
    ['nu-disco', 'disco-nu-disco'],
    ['Nu Disco', 'disco-nu-disco'],
    ['disco house', 'disco-nu-disco'],
    ['deep house', 'deep-house'],
    ['deep-house', 'deep-house'],
    ['House', 'house'],
    ['house music', 'house'],
    ['tech house', 'tech-house'],
    ['tech-house', 'tech-house'],
    ['techhouse', 'tech-house'],
    ['progressive house', 'progressive-house'],
    ['prog house', 'progressive-house'],
    ['melodic house', 'melodic-house'],
    ['melodic house and techno', 'melodic-house'],
    ['melodic house & techno', 'melodic-house'],
    ['techno', 'techno'],
    ['Techno!', 'techno'],
    ['peak time techno', 'techno'],
    ['driving techno', 'techno'],
    ['hard techno', 'hard-techno'],
    ['hardtechno', 'hard-techno'],
    ['industrial techno', 'hard-techno'],
    ['minimal', 'minimal'],
    ['minimal techno', 'minimal'],
    ['minimal house', 'minimal'],
    ['microhouse', 'minimal'],
    ['afro house', 'afro-house'],
    ['afrohouse', 'afro-house'],
    ['afro-house', 'afro-house'],
    ['organic house', 'organic-house'],
    ['organic house / downtempo', 'organic-house'],
    ['uk garage', 'uk-garage'],
    ['ukg', 'uk-garage'],
    ['2-step', 'uk-garage'],
    ['drum and bass', 'drum-and-bass'],
    ['drum & bass', 'drum-and-bass'],
    ["drum'n'bass", 'drum-and-bass'],
    ['dnb', 'drum-and-bass'],
    ['d&b', 'drum-and-bass'],
    ['trance', 'trance'],
    ['progressive trance', 'trance'],
    ['uplifting trance', 'trance'],
    ['psytrance', 'trance'],
    ['electro', 'electro'],
    ['electro house', 'electro'],
    ['breaks', 'breaks'],
    ['breakbeat', 'breaks'],
    ['downtempo', 'downtempo'],
    ['big room', 'big-room'],
    ['big room house', 'big-room'],
    ['bass house', 'bass-house'],
    ['bass-house', 'bass-house'],
  ];
  it(`maps ${cases.length} tag strings`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    for (const [tag, lane] of cases) expect([tag, one(tag)]).toEqual([tag, [lane]]);
  });
  it('every lane is reachable from at least one alias', () => {
    const reached = new Set(cases.map(([, l]) => l));
    for (const l of LANES) expect(reached.has(l)).toBe(true);
  });
  it('laneOfTag returns undefined for non-genre tags', () => {
    expect(laneOfTag('techno')).toBe('techno');
    expect(laneOfTag('seen live')).toBeUndefined();
  });
});

describe('lanesFromTags', () => {
  it('ignores non-genre tags', () => {
    const tags = ['seen live', '2019', 'favorites', 'Favourite', 'male vocalists', 'electronic', 'dance', 'love', 'awesome'].map((name) => ({ name, count: 100 }));
    expect(lanesFromTags(tags)).toEqual([]);
  });
  it('orders by weight and caps at 3', () => {
    const out = lanesFromTags([
      { name: 'techno', count: 40 },
      { name: 'melodic techno', count: 100 },
      { name: 'seen live', count: 90 },
      { name: 'deep house', count: 10 },
      { name: 'minimal', count: 5 },
    ]);
    expect(out).toEqual(['melodic-techno', 'techno', 'deep-house']);
  });
  it('sums tags that map to the same lane', () => {
    const out = lanesFromTags([
      { name: 'house', count: 50 },
      { name: 'deep house', count: 30 },
      { name: 'deep-house', count: 30 },
    ]);
    expect(out).toEqual(['deep-house', 'house']);
  });
  it('drops non-DJ and mood tags', () => {
    for (const t of ['hardcore', 'garage', 'progressive', 'chill', 'ambient', 'lounge', 'chillout']) expect([t, one(t)]).toEqual([t, []]);
  });
  it('a specific lane outranks its generic parent, whatever the weights', () => {
    expect(lanesFromTags([{ name: 'house', count: 100 }, { name: 'tech house', count: 70 }])).toEqual(['tech-house', 'house']);
    expect(lanesFromTags([{ name: 'techno', count: 100 }, { name: 'melodic techno', count: 20 }])).toEqual(['melodic-techno', 'techno']);
    expect(lanesFromTags([{ name: 'techno', count: 100 }, { name: 'hard techno', count: 20 }])).toEqual(['hard-techno', 'techno']);
  });
  it('several aliases of a generic lane do not outweigh a specific one', () => {
    const out = lanesFromTags([
      { name: 'techno', count: 60 }, { name: 'peak time techno', count: 60 }, { name: 'driving techno', count: 60 },
      { name: 'melodic techno', count: 50 }, { name: 'deep house', count: 55 },
    ]);
    expect(out[0]).toBe('deep-house');
    expect(out.indexOf('melodic-techno')).toBeLessThan(out.indexOf('techno'));
  });
  it('handles empty input', () => {
    expect(lanesFromTags([])).toEqual([]);
  });
});
