import { describe, expect, it } from 'vitest';
import { titleMatches } from '@/lib/sources/match';

const A = 'Some Artist';
/** [wanted, got] pairs that are the SAME recording family. */
const SAME: Array<[string, string]> = [
  ['Opus', 'Opus (Original Mix)'], ['Opus', 'Opus - Original Mix'], ['Opus', 'Opus - Radio Edit'], ['Opus', 'Opus (Radio Edit)'],
  ['Opus', 'Opus - Extended Mix'], ['Opus', 'Opus (Extended)'], ['Opus (Extended Mix)', 'Opus (Original Mix)'],
  ['Opus', 'Opus (feat. Guest)'], ['Opus', 'Opus [feat. Guest]'], ['Opus', 'Opus (with Guest)'], ['Opus', 'Opus - feat. Guest'], ['Opus (feat. Guest)', 'Opus'],
  ['Opus', 'Opus - 2014 Remaster'], ['Opus', 'Opus (2014 Remastered Version)'], ['Opus', 'Opus - Remastered 2014'], ['Opus', 'Opus (Remastered)'],
  ['Opus', 'Opus - Single Version'], ['Opus', 'Opus - Edit'], ['Opus', 'Opus (Original Version)'], ['Opus', 'Opus (Extended Version)'], ['Opus', 'Opus - Radio Mix'],
  ['Opus', 'Opus (Mixed)'], ['Opus', 'Opus - Mixed'], ['Opus', 'Opus (Mixed Version)'], ['Opus', 'Opus (12" Version)'], ['Opus', 'Opus (12" Mix)'],
  ['Opus', 'OPUS'], ['Rock & Roll', 'Rock and Roll'], ['Pt. 2', 'Part 2'], ['Désolé', 'Desole'], ["Rockin'", 'Rockin’'],
  // remixes by the SAME remixer
  ['Opus (X Remix)', 'Opus - X Remix'], ['Opus (X Remix)', 'Opus [X Remix]'], ['Opus (X Remix)', 'Opus (X Extended Remix)'], ['Opus (X Remix)', 'Opus (X Remix Edit)'],
  ['Opus (X Remix)', 'Opus - X Remix Edit'], ['Opus (X Remix)', 'Opus (X Remix - Radio Edit)'], ['Opus (X Remix)', 'Opus (X Remix) (Original Mix)'],
  ['Opus (X Remix)', 'Opus (X Remix) - Radio Edit'], ['Opus (X Remix)', 'Opus (X Extended Mix)'], ['Opus (X Remix)', 'Opus (feat. Y) [X Remix]'],
];
/** Pairs that must be REJECTED: another remixer, original vs remix, or another song. */
const DIFFERENT: Array<[string, string]> = [
  ['Opus', 'Opus (Eric Prydz Extended Mix)'], ['Opus', 'Opus (Eric Prydz Remix - Radio Edit)'], ['Opus', 'Opus (X Remix) (Original Mix)'],
  ['Opus', 'Opus (X Remix)'], ['Opus (X Remix)', 'Opus'], ['Opus (X Remix)', 'Opus (Original Mix)'], ['Opus', 'Opus (X Extended Mix)'],
  ['Opus (X Remix)', 'Opus (Y Remix)'], ['Opus (X Remix)', 'Opus - Y Remix'], ['Opus (X Remix)', 'Opus [Y Remix]'], ['Opus (X Remix)', 'Opus (Y Extended Mix)'],
  ['Opus (X Remix)', 'Opus (Y Remix - Radio Edit)'], ['Opus (X Remix)', 'Opus (Y Remix) (Original Mix)'],
  ['Opus', 'Opus (Dub Mix)'], ['Opus', 'Opus - Live'], ['Opus', 'Opus Two'], ['Opus', 'Aerodynamic'], ['Part 2', 'Part 3'], ['Opus', 'Opus (VIP)'],
];

describe('titleMatches (same recording family, by title + version identity)', () => {
  it.each(SAME)('%s ~ %s', (wanted, got) => expect(titleMatches(wanted, got, A)).toBe(true));
  it.each(DIFFERENT)('%s !~ %s', (wanted, got) => expect(titleMatches(wanted, got, A)).toBe(false));

  it('"(X Extended Mix)" is the original when X is the track artist, a remix by X when it is another artist', () => {
    expect(titleMatches('Opus', 'Opus (Some Artist Extended Mix)', A)).toBe(true);
    expect(titleMatches('Opus', 'Opus (Eric Prydz Extended Mix)', A)).toBe(false);
    expect(titleMatches('Opus (Eric Prydz Remix)', 'Opus (Eric Prydz Extended Mix)', A)).toBe(true);
  });
  it('never matches an empty title', () => {
    expect(titleMatches('', '')).toBe(false);
    expect(titleMatches('Opus', undefined)).toBe(false);
  });
});
