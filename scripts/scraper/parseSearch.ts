import * as cheerio from 'cheerio';
import { ParseError } from './parseTracklist';

export const BASE_URL = 'https://www.1001tracklists.com';

export interface SearchResult {
  id: string;
  url: string;
  title: string;
  date?: string;
}

export function parseSearch(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const rows = $('div.bItm.action.oItm').toArray();
  if (rows.length === 0) {
    if (/returns nothing/i.test($('body').text())) return [];
    throw new ParseError('div.bItm.action.oItm');
  }
  return rows.map((el, i) => {
    const row = $(el);
    const a = row.find('.bTitle a').first();
    const href = a.attr('href');
    if (!href) throw new ParseError('.bTitle a', `missing href in result ${i + 1}`);
    const m = href.match(/^\/tracklist\/([a-z0-9]+)\//i);
    if (!m) throw new ParseError('.bTitle a', `href is not a /tracklist/ url in result ${i + 1}: ${href}`);
    const date = row.find('[title="tracklist date"]').first().text().trim();
    const result: SearchResult = {
      id: m[1],
      url: BASE_URL + href,
      title: a.text().replace(/\s+/g, ' ').trim(),
    };
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) result.date = date;
    return result;
  });
}
