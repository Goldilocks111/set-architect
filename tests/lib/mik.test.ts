import { describe, expect, it } from 'vitest';
import { musicalKeyToCamelot, parseMikCsv } from '@/lib/mik';

describe('musicalKeyToCamelot', () => {
  it.each([
    ['F#m', '11A'], ['F# minor', '11A'], ['Gbm', '11A'], ['A minor', '8A'], ['Amin', '8A'], ['Am', '8A'],
    ['Bbmaj', '6B'], ['Bb major', '6B'], ['Bb', '6B'], ['C', '8B'], ['C major', '8B'], ['G', '9B'], ['Em', '9A'],
    ['Db', '3B'], ['C#', '3B'], ['Gb', '2B'], ['F#', '2B'], ['G#m', '1A'], ['Abm', '1A'], ['Ebm', '2A'], ['D#m', '2A'],
    ['Bm', '10A'], ['Cm', '5A'], ['Gm', '6A'], ['Fm', '4A'], ['Bbm', '3A'], ['D', '10B'], ['A', '11B'], ['Eb', '5B'], ['Ab', '4B'], ['Dm', '7A'], ['F', '7B'], ['E', '12B'], ['B', '1B'], ['C♯m', '12A'], ['B♭', '6B'],
    ['8A', '8A'], ['12b', '12B'], [' 5a ', '5A'],
    ['1d', '8B'], ['1m', '8A'], ['6d', '1B'], ['12m', '7A'], ['7m', '2A'],
  ])('%s -> %s', (input, out) => {
    expect(musicalKeyToCamelot(input)).toBe(out);
  });
  it.each([[''], ['H'], ['13A'], ['0B'], ['13m'], ['C sharp'], ['xyz']])('rejects %j', (input) => {
    expect(musicalKeyToCamelot(input)).toBeUndefined();
  });
});

describe('parseMikCsv', () => {
  it('reads case-insensitive headers (comma)', () => {
    const r = parseMikCsv('ARTIST,title,Key result,Tempo,ENERGY\nDaft Punk,One More Time,F#m,123.5,7\n');
    expect(r).toEqual({ rows: [{ artist: 'Daft Punk', title: 'One More Time', camelot: '11A', bpm: 123.5, energy: 7 }], skipped: 0 });
  });
  it('accepts Key/BPM headers and Camelot values', () => {
    const r = parseMikCsv('Artist,Title,Key,BPM,Energy\nA,B,8A,128,5');
    expect(r.rows[0]).toEqual({ artist: 'A', title: 'B', camelot: '8A', bpm: 128, energy: 5 });
  });
  it('handles semicolons, BOM, quoted fields and decimal commas', () => {
    const r = parseMikCsv('﻿Artist;Title;Key;BPM;Energy\r\n"Foo; Bar";"Say ""Hi"", Now";A minor;"124,5";6\r\n');
    expect(r.rows).toEqual([{ artist: 'Foo; Bar', title: 'Say "Hi", Now', camelot: '8A', bpm: 124.5, energy: 6 }]);
  });
  it('handles a quoted field with an embedded newline', () => {
    const r = parseMikCsv('Artist,Title,BPM\n"A","Two\nLines",120');
    expect(r.rows[0].title).toBe('Two\nLines');
  });
  it('falls back to "Artist - Title" from File name', () => {
    const r = parseMikCsv('File name,Key,BPM\nArtist X - Song Y (Extended Mix).mp3,Bbmaj,126\nno-separator.mp3,8A,120\n');
    expect(r.rows).toEqual([{ artist: 'Artist X', title: 'Song Y (Extended Mix)', camelot: '6B', bpm: 126 }]);
    expect(r.skipped).toBe(1);
  });
  it('prefers Artist/Title columns over File name', () => {
    const r = parseMikCsv('Artist,Title,File name,BPM\nReal,Name,Other - Thing.mp3,100');
    expect(r.rows[0]).toMatchObject({ artist: 'Real', title: 'Name' });
  });
  it('parses key and energy from a combined Comment', () => {
    const r = parseMikCsv('Artist,Title,Comment\nA,B,8A - Energy 6\nC,D,"Energy 9 - 11B"');
    expect(r.rows).toEqual([
      { artist: 'A', title: 'B', camelot: '8A', energy: 6 },
      { artist: 'C', title: 'D', camelot: '11B', energy: 9 },
    ]);
  });
  it('does not read free-text comments as keys', () => {
    const r = parseMikCsv('Artist,Title,Comment,BPM\nA,B,cut at 4b intro 2a,120\nC,D,Key: 3B,121');
    expect(r.rows).toEqual([{ artist: 'A', title: 'B', bpm: 120 }, { artist: 'C', title: 'D', camelot: '3B', bpm: 121 }]);
  });
  it('splits the file name at the first " - " and reads tab-delimited files', () => {
    const r = parseMikCsv('File name\tKey\tBPM\nDJ X - Song - Part 2.wav\t8A\t120');
    expect(r.rows[0]).toMatchObject({ artist: 'DJ X', title: 'Song - Part 2', camelot: '8A' });
  });
  it('columns beat the comment', () => {
    const r = parseMikCsv('Artist,Title,Key,Energy,Comment\nA,B,9A,4,8A - Energy 6');
    expect(r.rows[0]).toMatchObject({ camelot: '9A', energy: 4 });
  });
  it('counts unusable rows as skipped, keeps partial rows', () => {
    const r = parseMikCsv('Artist,Title,Key,BPM,Energy\nA,B,nope,,\n,Only title,8A,120,5\nC,D,nope,130,\nE,F,,,\n\n');
    expect(r.rows).toEqual([{ artist: 'C', title: 'D', bpm: 130 }]);
    expect(r.skipped).toBe(3);
  });
  it('returns nothing for empty or header-less-of-use input', () => {
    expect(parseMikCsv('')).toEqual({ rows: [], skipped: 0 });
    expect(parseMikCsv('Foo,Bar\n1,2').rows).toEqual([]);
  });
});
