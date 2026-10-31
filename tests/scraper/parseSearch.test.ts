// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSearch } from '../../scripts/scraper/parseSearch';
import { ParseError } from '../../scripts/scraper/parseTracklist';

const fx = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('parseSearch', () => {
  it('extracts id, absolute url, title and date from result rows', () => {
    const rows = parseSearch(fx('search.sample.html'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      id: '9ycgytk',
      url: 'https://www.1001tracklists.com/tracklist/9ycgytk/oliver-heldens-heldeep-radio-643-2026-10-30.html',
      title: 'Oliver Heldens - Heldeep Radio 643',
      date: '2026-10-30',
    });
    expect(rows[1].id).toBe('1g8mdh3t');
  });

  it('returns an empty list when the site says the search returns nothing', () => {
    expect(parseSearch(fx('search.empty.html'))).toEqual([]);
  });

  it('throws ParseError on a page that is neither results nor "returns nothing"', () => {
    expect(() => parseSearch('<html><body>captcha</body></html>')).toThrow(ParseError);
    expect(() => parseSearch('<html><body>captcha</body></html>')).toThrow(/div\.bItm\.action\.oItm/);
  });

  it('throws ParseError when a result row has no title link', () => {
    const html = fx('search.sample.html').replace(/bTitle/g, 'renamed');
    expect(() => parseSearch(html)).toThrow(/\.bTitle a/);
  });

  it('never returns /track/ urls', () => {
    const html = fx('search.sample.html').replace(/\/tracklist\/9ycgytk\//g, '/track/9ycgytk/');
    expect(() => parseSearch(html)).toThrow(ParseError);
  });
});
