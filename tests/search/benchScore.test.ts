import { describe, expect, it } from 'vitest';
import { isHit, hitRank, hitDetail, artistRule, versionCorrect, normalize, type BenchTrack, type BenchVersionCase } from '../../bench/search/score';

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

describe('scorer regressions', () => {
  it('multi-artist match is order-independent', () => {
    expect(isHit(track('Skrillex, Solomun', 'Rumpta'), [{ artist: 'Solomun, Skrillex', baseTitle: 'Rumpta' }])).toBe(true);
  });
  it('strips a trailing parenthetical from the provider baseTitle too', () => {
    expect(isHit(track('Modjo', 'Lady (Hear Me Tonight)'), [{ artist: 'Modjo', baseTitle: 'Lady (Hear Me Tonight)' }])).toBe(true);
    expect(isHit(track('Eiffel 65', 'Blue (Da Ba Dee)'), [{ artist: 'Eiffel 65', baseTitle: 'Blue (Da Ba Dee)' }])).toBe(true);
    expect(isHit(track('Modjo', 'Lady (Hear Me Tonight)'), [{ artist: 'Modjo', title: 'Lady (Hear Me Tonight)' }])).toBe(true);
  });
  it('artist comparison ignores spaces', () => {
    expect(isHit(track('Brutalismus3000', 'X'), [{ artist: 'Brutalismus 3000', baseTitle: 'X' }])).toBe(true);
    expect(isHit(track('Brutalismus 3000', 'X'), [{ artist: 'Boys Noize, Brutalismus3000', baseTitle: 'X' }])).toBe(true);
  });
});

describe('strict artist matching', () => {
  const miss = (artist: string, want: string, got: string, title = 'Song') =>
    expect(isHit(track(want, title), [{ artist: got, baseTitle: title }])).toBe(false);
  it('rejects tribute / fan-club / sound-alike names that merely contain the artist', () => {
    miss('Disclosure', 'Disclosure', 'Disclosure Fan Club');
    miss('Disclosure', 'Disclosure', 'Tribute to Disclosure');
    miss('Stardust', 'Stardust', 'Ziggy Stardust');
    miss('Fisher', 'Fisher', 'The Fisher Kings');
  });
  it('keeps duo names whole', () => {
    miss('Above & Beyond', 'Above & Beyond', 'Above');
    miss('Above & Beyond', 'Above & Beyond', 'Beyond');
    miss('Chase & Status', 'Chase & Status', 'Status Quo');
    expect(isHit(track('Above & Beyond', 'Song'), [{ artist: 'Above & Beyond', baseTitle: 'Song' }])).toBe(true);
    expect(isHit(track('Above & Beyond', 'Song'), [{ artist: 'Above, Beyond', baseTitle: 'Song' }])).toBe(true);
  });
  it('accepts any credited artist, in any order', () => {
    expect(isHit(track('CamelPhat, Elderbrook', 'Song'), [{ artist: 'Elderbrook, CamelPhat', baseTitle: 'Song' }])).toBe(true);
  });
  it('versionCorrect rejects a tribute act', () => {
    const c: BenchVersionCase = { id: 'c', query: 'q', source: 'x', expect: { artist: 'CamelPhat', baseTitle: 'Cola', kind: 'original' } };
    expect(versionCorrect(c, [{ artist: 'CamelPhat Tribute Band', version: v('Cola', 'original') }])).toBe(false);
  });
});

describe('strict title matching', () => {
  const t = (title: string) => track('Daft Punk', title);
  it('does not strip a parsed baseTitle', () => {
    expect(isHit(t('One More Time'), [{ artist: 'Daft Punk', baseTitle: 'One More Time (Mike Posner Cover)' }])).toBe(false);
    expect(isHit(t('Deeper Love'), [{ artist: 'Daft Punk', baseTitle: 'Deeper Love (Part 2)' }])).toBe(false);
    expect(isHit(t('Latch'), [{ artist: 'Daft Punk', baseTitle: 'Latch - Cover' }])).toBe(false);
    expect(isHit(t('Latch'), [{ artist: 'Daft Punk', baseTitle: 'Latch (Karaoke Version)' }])).toBe(false);
  });
  it('still matches parenthetical titles that belong to the work', () => {
    expect(isHit(track('Modjo', 'Lady (Hear Me Tonight)'), [{ artist: 'Modjo', baseTitle: 'Lady (Hear Me Tonight)' }])).toBe(true);
    expect(isHit(track('Eiffel 65', 'Blue (Da Ba Dee)'), [{ artist: 'Eiffel 65', baseTitle: 'Blue (Da Ba Dee)' }])).toBe(true);
  });
  it('strips the qualifier only when falling back to a raw title', () => {
    expect(isHit(t('Latch'), [{ artist: 'Daft Punk', title: 'Latch (Extended Mix)' }])).toBe(true);
  });
  it('reports the rank of the match', () => {
    expect(hitRank(t('Latch'), [{ artist: 'x', baseTitle: 'y' }, { artist: 'Daft Punk', baseTitle: 'Latch' }])).toBe(1);
  });
});

describe('duration window', () => {
  const c: BenchVersionCase = { id: 'c', query: 'q', source: 'x', durationMs: 200000, expect: { artist: 'Fisher', baseTitle: 'Rain', kind: 'extended' } };
  it('rejects a result whose duration is outside +-10s', () => {
    expect(versionCorrect(c, [{ artist: 'Fisher', version: v('Rain', 'extended'), durationMs: 215000 }])).toBe(false);
    expect(versionCorrect(c, [{ artist: 'Fisher', version: v('Rain', 'extended'), durationMs: 195000 }])).toBe(true);
  });
  it('ignores duration when the result has none', () => {
    expect(versionCorrect(c, [{ artist: 'Fisher', version: v('Rain', 'extended') }])).toBe(true);
  });
});

describe('combined and lead-only artist credits', () => {
  const hit = (want: string, got: string, aliases?: Record<string, string[]>) =>
    isHit({ ...track(want, 'Cola'), aliases }, [{ artist: got, baseTitle: 'Cola' }]);
  it('accepts combined credit strings from providers that do not comma-list', () => {
    expect(hit('CamelPhat, Elderbrook', 'CamelPhat & Elderbrook')).toBe(true);
    expect(hit('CamelPhat, Elderbrook', 'CamelPhat x Elderbrook')).toBe(true);
    expect(hit('CamelPhat, Elderbrook', 'CamelPhat and Elderbrook')).toBe(true);
  });
  it('keeps a credited duo whole and tolerates extra featured artists', () => {
    expect(hit('Above & Beyond', 'Above & Beyond & Richard Bedford')).toBe(true);
    expect(hit('Above & Beyond', 'Above')).toBe(false);
    expect(hit('Above & Beyond', 'Beyond & Richard Bedford')).toBe(false);
    expect(hit('Above & Beyond', 'Richard Bedford')).toBe(false);
  });
  it('accepts a lead-only credit (Deezer lists the main artist)', () => {
    expect(hit('Skrillex, Solomun', 'Skrillex')).toBe(true);
    expect(hit('Dombresky, Disco Dom', 'Dombresky')).toBe(true);
  });
  it('accepts a secondary-only credit but still rejects impostors', () => {
    expect(hit('CamelPhat, Elderbrook', 'Elderbrook')).toBe(true);
    expect(hit('Skrillex, Solomun', 'Solomun')).toBe(true);
    expect(hit('Dombresky, Disco Dom', 'Disco Dom')).toBe(true);
    expect(hit('Skrillex, Solomun', 'Solomun Fan Club')).toBe(false);
    expect(hit('Skrillex, Solomun', 'Someone Else')).toBe(false);
    expect(hit('Disclosure', 'Disclosure Fan Club')).toBe(false);
    expect(hit('Disclosure', 'Tribute to Disclosure')).toBe(false);
    expect(hit('Chase & Status', 'Status Quo')).toBe(false);
  });
  it('supports per-fixture aliases and reports the rule used', () => {
    const al = { 'Rüfüs Du Sol': ['RÜFÜS'] };
    expect(hit('Rüfüs Du Sol', 'RÜFÜS', al)).toBe(true);
    expect(hit('Rüfüs Du Sol', 'RÜFÜS')).toBe(false);
    expect(artistRule('Rüfüs Du Sol', 'RÜFÜS', al)).toBe('alias');
    expect(artistRule('Rüfüs Du Sol', 'RÜFÜS DU SOL')).toBe('exact');
    expect(artistRule('CamelPhat, Elderbrook', 'CamelPhat')).toBe('subset-with-lead');
    expect(artistRule('CamelPhat, Elderbrook', 'Elderbrook')).toBe('subset-secondary-only');
    expect(artistRule('CamelPhat, Elderbrook', 'Elderbrook, CamelPhat')).toBe('exact');
    expect(hitDetail(track('Fisher', 'Cola'), [{ artist: 'Fisher', baseTitle: 'Cola' }])).toEqual({ rank: 0, via: 'exact' });
  });
  it('ignores soundtrack tags on both sides', () => {
    const got = 'Pusher (feat. Gesaffelstein) [From GTAVI: Original Score]';
    expect(isHit(track('Justice', 'Pusher'), [{ artist: 'Justice', baseTitle: got }])).toBe(true);
    expect(isHit(track('Justice', 'Pusher [From X]'), [{ artist: 'Justice', baseTitle: 'Pusher' }])).toBe(true);
    expect(isHit(track('Justice', 'Pusher'), [{ artist: 'Justice', baseTitle: 'Pusher (Part 2)' }])).toBe(false);
  });
});

describe('+extras tag', () => {
  it('marks results that credit artists outside the fixture set', () => {
    expect(artistRule('CamelPhat, Elderbrook', 'CamelPhat, Elderbrook, Someone')).toBe('exact+extras');
    expect(artistRule('Above & Beyond', 'Above & Beyond & Richard Bedford')).toBe('exact+extras');
    expect(artistRule('Chase & Status', 'Chase & Status, Tribute')).toBe('exact+extras');
    expect(artistRule('Skrillex, Solomun', 'Solomun, Guest')).toBe('subset-secondary-only+extras');
    expect(artistRule('Skrillex, Solomun', 'Skrillex, Guest')).toBe('subset-with-lead+extras');
    expect(artistRule('Rüfüs Du Sol', 'RÜFÜS, Guest', )).toBeNull();
  });
  it('leaves clean results untagged and still hits with extras', () => {
    expect(artistRule('CamelPhat, Elderbrook', 'CamelPhat')).toBe('subset-with-lead');
    expect(isHit(track('Chase & Status', 'Song'), [{ artist: 'Chase & Status, Tribute', baseTitle: 'Song' }])).toBe(true);
  });
});
