// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseTracklist, ParseError } from '../../scripts/scraper/parseTracklist';

const fx = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('parseTracklist', () => {
  const result = parseTracklist(fx('tracklist.sample.html'));

  it('extracts the tracklist id and title', () => {
    expect(result.id).toBe('9ycgytk');
    expect(result.title).toContain('Heldeep Radio 643');
  });

  it('extracts ordered tracks with position, artist and title', () => {
    expect(result.tracks.map((t) => t.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.tracks[0]).toEqual({ position: 1, artist: 'Adriatique', title: 'Disappear' });
    expect(result.tracks[2]).toEqual({ position: 3, artist: 'Will Clarke', title: "Snitchin'" });
    expect(result.tracks[4].artist).toBe('Oliver Heldens & Will Clarke');
    expect(result.tracks[4].title).toBe('Lost In Music');
  });

  it('splits a trailing remix suffix off the title', () => {
    expect(result.tracks[5]).toEqual({
      position: 6,
      artist: 'Kryder & Cammie Robinson',
      title: 'Blinded By The Lights',
      remix: 'Mark Knight Remix',
    });
  });

  it('throws ParseError naming the missing selector on a mangled page', () => {
    expect(() => parseTracklist(fx('tracklist.mangled.html'))).toThrow(ParseError);
    expect(() => parseTracklist(fx('tracklist.mangled.html'))).toThrow(/\.trackValue/);
  });

  it('throws ParseError when there are no track rows at all', () => {
    expect(() => parseTracklist('<html><head><link rel="canonical" href="https://x/tracklist/abc123/x.html"></head></html>')).toThrow(/div\.tlpTog/);
  });

  it('throws ParseError when the tracklist id cannot be determined', () => {
    const html = fx('tracklist.sample.html').replace(/<link rel="canonical"[^>]*>/, '');
    expect(() => parseTracklist(html)).toThrow(/canonical/);
  });
});
