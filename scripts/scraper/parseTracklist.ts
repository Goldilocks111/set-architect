import * as cheerio from 'cheerio';

export class ParseError extends Error {
  constructor(public readonly selector: string, detail = 'not found') {
    super(`ParseError: selector "${selector}" ${detail}`);
    this.name = 'ParseError';
  }
}

export interface ParsedTrack {
  position: number;
  artist: string;
  title: string;
  remix?: string;
}

export interface ParsedTracklist {
  id: string;
  title: string;
  tracks: ParsedTrack[];
}

const REMIX_RE = /\b(remix|rework|bootleg|edit|vip|dub|flip|mashup|refix)\b/i;
const EDIT_DATA_RE = /\b(remix|rework|bootleg)\b/i;
const ORIGINAL_RE = /^(original|extended|radio)( mix| edit)?$/i;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "Title (Foo Remix)" -> { title: "Title", remix: "Foo Remix" }; "Original Mix" style tags are dropped. */
export function splitRemix(raw: string, extra?: string): { title: string; remix?: string } {
  let title = clean(raw);
  let remix: string | undefined;
  const m = title.match(/^(.*?)\s*[([]([^()[\]]+)[)\]]\s*$/);
  if (m && m[1]) {
    if (REMIX_RE.test(m[2])) {
      title = m[1];
      remix = clean(m[2]);
    } else if (ORIGINAL_RE.test(clean(m[2]))) {
      title = m[1];
    }
  }
  if (!remix && extra && EDIT_DATA_RE.test(extra)) remix = clean(extra);
  return remix ? { title, remix } : { title };
}

function tracklistIdFrom(url: string | undefined): string | undefined {
  return url?.match(/\/tracklist\/([a-z0-9]+)\//i)?.[1];
}

export function parseTracklist(html: string): ParsedTracklist {
  const $ = cheerio.load(html);

  const id =
    tracklistIdFrom($('link[rel="canonical"]').attr('href')) ??
    tracklistIdFrom($('meta[property="og:url"]').attr('content'));
  if (!id) throw new ParseError('link[rel="canonical"]', 'missing or has no /tracklist/<id>/ path');

  const rows = $('div.tlpTog').toArray();
  if (rows.length === 0) throw new ParseError('div.tlpTog');

  const tracks: ParsedTrack[] = rows.map((el, i) => {
    const row = $(el);
    const posText = row.find('.fontXL').first();
    if (posText.length === 0) throw new ParseError('.fontXL', `missing in row ${i + 1}`);
    const position = parseInt(clean(posText.text()), 10);
    if (!Number.isFinite(position)) throw new ParseError('.fontXL', `non-numeric in row ${i + 1}`);

    const value = row.find('.trackValue').first();
    if (value.length === 0) throw new ParseError('.trackValue', `missing in row ${i + 1}`);
    const text = clean(value.text());
    const sep = text.indexOf(' - ');
    if (sep <= 0 || sep + 3 >= text.length) {
      throw new ParseError('.trackValue', `has no "Artist - Title" shape in row ${i + 1}: "${text}"`);
    }
    const artist = text.slice(0, sep).trim();
    const { title, remix } = splitRemix(text.slice(sep + 3), row.find('.trackEditData').first().text());
    return remix ? { position, artist, title, remix } : { position, artist, title };
  });

  const title = clean($('title').first().text()).replace(/\s*\|\s*1001Tracklists.*$/i, '');
  return { id, title, tracks };
}
