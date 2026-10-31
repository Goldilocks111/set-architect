import { describe, it, expect } from 'vitest';
import { parseVersion } from '@/lib/search/version';

type Expected = {
  baseTitle: string;
  kind: string;
  label?: string;
  remixer?: string;
  featuring?: string[];
};

const cases: Array<[string, Expected]> = [
  // brief cases
  ['Cola (Original Mix)', { baseTitle: 'Cola', kind: 'original' }],
  ['Cola', { baseTitle: 'Cola', kind: 'original' }],
  ['Cola (Extended Mix)', { baseTitle: 'Cola', kind: 'extended', label: 'Extended Mix' }],
  ['Cola - Radio Edit', { baseTitle: 'Cola', kind: 'radio', label: 'Radio Edit' }],
  ['Cola (Mark Knight Remix)', { baseTitle: 'Cola', kind: 'remix', label: 'Mark Knight Remix', remixer: 'Mark Knight' }],
  ['Opus (Four Tet Remix) [Extended]', { baseTitle: 'Opus', kind: 'remix', remixer: 'Four Tet' }],
  ['Breathe (feat. Cristoph)', { baseTitle: 'Breathe', kind: 'original', featuring: ['Cristoph'] }],
  ['Track - 2014 Remaster', { baseTitle: 'Track', kind: 'remaster', label: '2014 Remaster' }],
  ['Track (VIP)', { baseTitle: 'Track', kind: 'vip', label: 'VIP' }],
  ['Track (Dub Mix)', { baseTitle: 'Track', kind: 'dub', label: 'Dub Mix' }],
  ['Track - Live at Printworks', { baseTitle: 'Track', kind: 'live', label: 'Live at Printworks' }],
  ['Track (Instrumental)', { baseTitle: 'Track', kind: 'instrumental', label: 'Instrumental' }],
  ['Track (with X)', { baseTitle: 'Track', kind: 'original', featuring: ['X'] }],
  ['Track [ft. X]', { baseTitle: 'Track', kind: 'original', featuring: ['X'] }],
  ['Delilah (pull me out of this)', { baseTitle: 'Delilah (pull me out of this)', kind: 'original' }],

  // titles whose parentheses belong to the name
  ['(I Just) Died In Your Arms', { baseTitle: '(I Just) Died In Your Arms', kind: 'original' }],
  ['(I Just) Died In Your Arms (Extended Mix)', { baseTitle: '(I Just) Died In Your Arms', kind: 'extended' }],
  ['Wake Me Up (Live Forever)', { baseTitle: 'Wake Me Up (Live Forever)', kind: 'original' }],
  ['Song (With or Without You)', { baseTitle: 'Song (With or Without You)', kind: 'original' }],
  ['Song (With You)', { baseTitle: 'Song (With You)', kind: 'original' }],
  ['Dub Be Good (Dub Mix)', { baseTitle: 'Dub Be Good', kind: 'dub' }],
  ['Jay-Z Style - Extended Mix', { baseTitle: 'Jay-Z Style', kind: 'extended' }],

  // multiple qualifiers
  ['Track (Mark Knight Remix) - Extended Mix', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight' }],
  ['Track - Extended Mix (Mark Knight Remix)', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight' }],
  ['Track (feat. Y) [Extended Mix]', { baseTitle: 'Track', kind: 'extended', featuring: ['Y'] }],
  ['Track (Mark Knight Remix) (feat. Y)', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight', featuring: ['Y'] }],

  // remix family
  ['Track (Mark Knight Rework)', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight' }],
  ['Track (Mark Knight Bootleg)', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight' }],
  ['Track (Mark Knight Flip)', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight' }],
  ['Track (Mark Knight Edit)', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight' }],
  ['Track (Mark Knight Extended Remix)', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight' }],
  ["Track (Mark Knight's Remix)", { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight' }],
  ['Track - Mark Knight Remix', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight' }],
  ['Track [Mark Knight Remix]', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight' }],
  ['Track (Mark Knight & Dennis Ferrer Remix)', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight & Dennis Ferrer' }],
  ['Track (Remix by Mark Knight)', { baseTitle: 'Track', kind: 'remix', remixer: 'Mark Knight' }],
  ['Track (Remix)', { baseTitle: 'Track', kind: 'remix', label: 'Remix' }],
  ['Track (Club Remix)', { baseTitle: 'Track', kind: 'remix' }],

  // radio / extended synonyms
  ['Track (Edit)', { baseTitle: 'Track', kind: 'radio', label: 'Edit' }],
  ['Track - Radio Edit', { baseTitle: 'Track', kind: 'radio' }],
  ['Track (Radio Mix)', { baseTitle: 'Track', kind: 'radio' }],
  ['Track (Single Version)', { baseTitle: 'Track', kind: 'radio' }],
  ['Track (Club Mix)', { baseTitle: 'Track', kind: 'extended', label: 'Club Mix' }],
  ['Track (Original Extended Mix)', { baseTitle: 'Track', kind: 'extended' }],
  ['Track - Extended Version', { baseTitle: 'Track', kind: 'extended' }],
  ['Track (Album Version)', { baseTitle: 'Track', kind: 'original' }],
  ['Track - Original Mix', { baseTitle: 'Track', kind: 'original' }],

  // other kinds
  ['Track (Original Dub Mix)', { baseTitle: 'Track', kind: 'dub' }],
  ['Track (Acoustic)', { baseTitle: 'Track', kind: 'acoustic' }],
  ['Track - Acoustic Version', { baseTitle: 'Track', kind: 'acoustic' }],
  ['Track - Remastered 2011', { baseTitle: 'Track', kind: 'remaster' }],
  ['Track (2014 Remastered Version)', { baseTitle: 'Track', kind: 'remaster' }],
  ['Track (Live)', { baseTitle: 'Track', kind: 'live' }],
  ['Track (VIP Mix)', { baseTitle: 'Track', kind: 'vip' }],
  ['Track (Acapella)', { baseTitle: 'Track', kind: 'other', label: 'Acapella' }],
  ['Track (Vocal Mix)', { baseTitle: 'Track', kind: 'other' }],
  ['Track (Deep Warehouse Mix)', { baseTitle: 'Track', kind: 'other', label: 'Deep Warehouse Mix' }],
  ['Track (Explicit)', { baseTitle: 'Track', kind: 'original' }],

  // featuring forms
  ['Breathe feat. Cristoph', { baseTitle: 'Breathe', kind: 'original', featuring: ['Cristoph'] }],
  ['Breathe ft. Cristoph', { baseTitle: 'Breathe', kind: 'original', featuring: ['Cristoph'] }],
  ['Breathe (featuring Cristoph)', { baseTitle: 'Breathe', kind: 'original', featuring: ['Cristoph'] }],
  ['Breathe (ft Cristoph)', { baseTitle: 'Breathe', kind: 'original', featuring: ['Cristoph'] }],
  ['Breathe (w/ Cristoph)', { baseTitle: 'Breathe', kind: 'original', featuring: ['Cristoph'] }],
  ['Breathe (w/Cristoph)', { baseTitle: 'Breathe', kind: 'original', featuring: ['Cristoph'] }],
  ['Breathe (with Cristoph)', { baseTitle: 'Breathe', kind: 'original', featuring: ['Cristoph'] }],
  ['Breathe (feat. A, B)', { baseTitle: 'Breathe', kind: 'original', featuring: ['A', 'B'] }],
  ['Breathe (feat. Above & Beyond)', { baseTitle: 'Breathe', kind: 'original', featuring: ['Above & Beyond'] }],
  ['Breathe (feat. Cristoph) - Extended Mix', { baseTitle: 'Breathe', kind: 'extended', featuring: ['Cristoph'] }],
  ['Breathe feat. Cristoph - Radio Edit', { baseTitle: 'Breathe', kind: 'radio', featuring: ['Cristoph'] }],

  // accents / unicode / dashes
  ['Ben Böhmer – Breathe (Extended Mix)', { baseTitle: 'Ben Böhmer – Breathe', kind: 'extended' }],
  ['Rüfüs (Müller Remix)', { baseTitle: 'Rüfüs', kind: 'remix', remixer: 'Müller' }],
  ['Track — Extended Mix', { baseTitle: 'Track', kind: 'extended' }],
  ['  Cola   (Extended   Mix)  ', { baseTitle: 'Cola', kind: 'extended', label: 'Extended Mix' }],

  // degenerate
  ['(Original Mix)', { baseTitle: '(Original Mix)', kind: 'original' }],
  ['', { baseTitle: '', kind: 'original' }],
];

describe('parseVersion', () => {
  it.each(cases)('%s', (raw, exp) => {
    const v = parseVersion(raw);
    expect(v.baseTitle).toBe(exp.baseTitle);
    expect(v.kind).toBe(exp.kind);
    expect(v.featuring).toEqual(exp.featuring ?? []);
    if ('label' in exp) expect(v.label).toBe(exp.label);
    if ('remixer' in exp) expect(v.remixer).toBe(exp.remixer);
    else expect(v.remixer).toBeUndefined();
  });

  it('keeps the extended label alongside a remix', () => {
    const v = parseVersion('Opus (Four Tet Remix) [Extended]');
    expect(v.label).toContain('Four Tet Remix');
    expect(v.label).toContain('Extended');
  });

  it('plain originals carry no label', () => {
    expect(parseVersion('Cola (Original Mix)').label).toBeUndefined();
    expect(parseVersion('Cola').label).toBeUndefined();
    expect(parseVersion('Cola (Explicit)').label).toBeUndefined();
  });

  it('never conflates an extended mix with a named remix', () => {
    const a = parseVersion('Cola (Extended Mix)');
    const b = parseVersion('Cola (Mark Knight Remix)');
    expect(a.baseTitle).toBe(b.baseTitle);
    expect(a.kind).not.toBe(b.kind);
  });

  it('is case-insensitive on keywords', () => {
    expect(parseVersion('cola (EXTENDED MIX)').kind).toBe('extended');
    expect(parseVersion('cola (mark knight REMIX)').remixer).toBe('mark knight');
  });

  it('accepts an optional artists argument', () => {
    expect(parseVersion('Cola (Extended Mix)', ['Disclosure']).kind).toBe('extended');
  });
});
