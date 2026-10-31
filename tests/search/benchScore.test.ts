import { describe, expect, it } from 'vitest';
import { isHit, versionCorrect, normalize, type BenchTrack, type BenchVersionCase } from '../../bench/search/score';

const track = (artist: string, title: string): BenchTrack => ({
  id: 't', artist, title, releaseYear: 2020, bucket: 'classic', query: `${artist} ${title}`, source: 'x',
});
const v = (baseTitle: string, kind: any, remixer?: string) => ({ baseTitle, kind, remixer, featuring: [] });

describe('normalize', () => {
  it('folds case, accents, & and feat.', () => {
    expect(normalize('Ben Böhmer')).toBe('ben bohmer');
    expect(normalize('Rüfüs Du Sol')).toBe('rufus du sol');
    expect(normalize('Disclosure & Eliza Doolittle')).toBe(normalize('disclosure and eliza doolittle'));
    expect(normalize('Cola (feat. Elderbrook)')).toBe('cola');
    expect(normalize('Cola ft. Elderbrook')).toBe('cola');
  });
});

describe('isHit', () => {
  it('matches case/accent-insensitively', () => {
    expect(isHit(track('Ben Böhmer', 'Breathing'), [{ artist: 'BEN BOHMER', baseTitle: 'breathing' }])).toBe(true);
  });
  it('matches a multi-artist result and feat. in the title', () => {
    expect(isHit(track('CamelPhat', 'Cola'), [{ artist: 'CamelPhat, Elderbrook', title: 'Cola (Extended Mix)' }])).toBe(true);
    expect(isHit(track('Fisher', 'Losing It'), [{ artist: 'FISHER', title: 'Losing It feat. X' }])).toBe(true);
  });
  it('treats & and "and" alike', () => {
    expect(isHit(track('Dennis Cruz & Ejeca', 'Hush'), [{ artist: 'Dennis Cruz, Ejeca', baseTitle: 'Hush' }])).toBe(true);
    expect(isHit(track('Bob and Jim', 'Song'), [{ artist: 'Bob & Jim', baseTitle: 'Song' }])).toBe(true);
  });
  it('rejects a different title or artist', () => {
    expect(isHit(track('Fisher', 'Losing It'), [{ artist: 'Fisher', baseTitle: 'Stop It' }])).toBe(false);
    expect(isHit(track('Fisher', 'Losing It'), [{ artist: 'Other', baseTitle: 'Losing It' }])).toBe(false);
  });
  it('only looks in the top N (default 5)', () => {
    const junk = Array.from({ length: 5 }, () => ({ artist: 'z', baseTitle: 'z' }));
    const hit = { artist: 'Fisher', baseTitle: 'Losing It' };
    expect(isHit(track('Fisher', 'Losing It'), [...junk, hit])).toBe(false);
    expect(isHit(track('Fisher', 'Losing It'), [...junk, hit], 6)).toBe(true);
  });
});

describe('versionCorrect', () => {
  const remixCase: BenchVersionCase = {
    id: 'c', query: 'q', source: 'x',
    expect: { artist: 'CamelPhat', baseTitle: 'Cola', kind: 'remix', remixer: 'Mark Knight' },
  };
  it('accepts the exact remix in the top 3', () => {
    expect(versionCorrect(remixCase, [
      { artist: 'CamelPhat', version: v('Cola', 'extended') },
      { artist: 'CamelPhat, Elderbrook', version: v('Cola', 'remix', 'Mark Knight') },
    ])).toBe(true);
  });
  it('rejects the wrong remixer or kind', () => {
    expect(versionCorrect(remixCase, [{ artist: 'CamelPhat', version: v('Cola', 'remix', 'Someone Else') }])).toBe(false);
    expect(versionCorrect(remixCase, [{ artist: 'CamelPhat', version: v('Cola', 'extended') }])).toBe(false);
  });
  it('ignores matches beyond rank 3', () => {
    const miss = { artist: 'x', version: v('y', 'original') };
    expect(versionCorrect(remixCase, [miss, miss, miss, { artist: 'CamelPhat', version: v('Cola', 'remix', 'Mark Knight') }])).toBe(false);
  });
  it('matches non-remix kinds without a remixer', () => {
    const c: BenchVersionCase = { id: 'c', query: 'q', source: 'x', expect: { artist: 'Fisher', baseTitle: 'Losing It', kind: 'extended' } };
    expect(versionCorrect(c, [{ artist: 'Fisher', version: v('Losing It', 'extended') }])).toBe(true);
  });
});
