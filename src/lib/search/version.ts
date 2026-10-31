import type { ParsedVersion, VersionKind } from './types';

/**
 * Splits a raw provider title into base title, version kind and featured artists.
 *
 * Only (parenthesised), [bracketed] and " - dash suffix" segments are inspected, and a
 * segment is removed from the base title only when it is positively recognised, so
 * parentheses that belong to the name ("Delilah (pull me out of this)") are left alone.
 */

/** Keyword -> kind for plain version segments (everything that is not a remix/live/remaster/featuring). */
const WORD_KIND: Record<string, VersionKind> = {
  // original
  original: 'original',
  album: 'original',
  main: 'original',
  // radio
  radio: 'radio',
  single: 'radio',
  short: 'radio',
  video: 'radio',
  tv: 'radio',
  // extended
  extended: 'extended',
  club: 'extended',
  long: 'extended',
  full: 'extended',
  length: 'extended',
  // dub / vip / instrumental / acoustic
  dub: 'dub',
  vip: 'vip',
  instrumental: 'instrumental',
  acoustic: 'acoustic',
  unplugged: 'acoustic',
  stripped: 'acoustic',
  // other
  vocal: 'other',
  acapella: 'other',
  demo: 'other',
  bonus: 'other',
  reprise: 'other',
  intro: 'other',
  outro: 'other',
  dj: 'other',
  mono: 'other',
  stereo: 'other',
  uncut: 'other',
};

/** When several keywords appear in one segment, the earliest kind in this list wins. */
const KIND_PRIORITY: VersionKind[] = [
  'remix',
  'vip',
  'dub',
  'live',
  'acoustic',
  'instrumental',
  'remaster',
  'extended',
  'radio',
  'other',
  'original',
];

/** Neutral tail words that carry no kind of their own. */
const NEUTRAL_WORDS = new Set(['mix', 'version', 'edit', 'cut', 'mixed']);

/** Content tags that are dropped from the title without becoming a version. */
const NOISE_WORDS = new Set(['explicit', 'clean', 'dirty', 'censored', 'uncensored', 'version']);

/** Words that describe a mix rather than name a remixer ("Radio Edit", "Club Remix"). */
const MODIFIER_WORDS = new Set([
  'radio', 'club', 'single', 'album', 'short', 'extended', 'original', 'video', 'vocal',
  'instrumental', 'tv', 'main', 'long', 'full', 'dub', 'official', 'clean', 'explicit', 'dirty',
]);

const REMIX_KEYWORD = /^(?:(.*?)\s+)?(remix|rework|bootleg|flip|refix|re-?edit|mashup|edit)$/i;
const REMIX_BY = /^(?:remix(?:ed)?|rework(?:ed)?|edit(?:ed)?)\s+by\s+(.+)$/i;
const FEATURING_STRONG = /^(?:featuring|feat|ft)(?:\.\s*|\s+)(.+)$/i;
const FEATURING_WITH = /^(with\s+|w\/\s*)(.+)$/i;
const LIVE = /^(?:recorded\s+)?live(?:\s+(?:at|in|from|on|@)\s+.+|\s+version|\s+session|\s+recording)?$/i;
const REMASTER = /\bre-?master(?:ed)?\b/i;

/** A "with X" tail that is really part of a title ("With or Without You", "With You"). */
const NOT_A_FEATURED_NAME = new Set(['you', 'me', 'him', 'her', 'us', 'them', 'it', 'my', 'your', 'our', 'the', 'a', 'an', 'or', 'and', 'no']);

interface Segment {
  kind?: VersionKind;
  label?: string;
  remixer?: string;
  featuring?: string[];
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

const ACRONYMS = new Set(['vip', 'dj', 'tv', 'uk', 'us', 'usa', 'ep', 'lp', 'dnb']);
const SMALL_WORDS = new Set(['at', 'in', 'from', 'on', 'of', 'the', 'a', 'an', 'by', 'and', 'for', 'with']);

/** One canonical spelling per qualifier so labels can be compared across punctuation styles and casings. */
function canonicalLabel(text: string): string {
  return clean(text.replace(/['’]s\b/gi, ''))
    .split(' ')
    .map((tok, i) => {
      const lower = tok.toLowerCase();
      if (tok !== lower && tok !== tok.toUpperCase()) return tok; // mixed case (McDonald, DJ-less names) is deliberate
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function splitNames(s: string): string[] {
  return s.split(',').map(clean).filter(Boolean);
}

function norm(tok: string): string {
  return tok.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function foldName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cleanRemixerName(raw: string): string | undefined {
  const toks = clean(raw.replace(/['’]s$/i, '')).split(' ').filter(Boolean);
  while (toks.length && MODIFIER_WORDS.has(toks[toks.length - 1].toLowerCase())) toks.pop();
  return toks.length ? toks.join(' ') : undefined;
}

function classifyFeaturing(text: string, artists: string[]): Segment | null {
  const strong = FEATURING_STRONG.exec(text);
  if (strong) {
    const names = splitNames(strong[1]);
    return names.length ? { featuring: names } : null;
  }
  const w = FEATURING_WITH.exec(text);
  if (!w) return null;
  const names = splitNames(w[2]);
  if (!names.length) return null;
  const isLowerWith = w[1].startsWith('w/') || w[1].startsWith('W/') || w[1].startsWith('with');
  if (isLowerWith) {
    // "(with deadmau5)": lowercase is a credit, unless it is plainly a phrase ("with you").
    if (NOT_A_FEATURED_NAME.has(names[0].split(' ')[0].toLowerCase())) return null;
    return { featuring: names };
  }
  // "(With Love)" is a title unless the named party is a known artist of this track.
  const known = new Set(artists.map(foldName));
  return names.every((n) => known.has(foldName(n))) ? { featuring: names } : null;
}

function classifyRemix(text: string): Segment | null {
  const by = REMIX_BY.exec(text);
  if (by) {
    const remixer = cleanRemixerName(by[1]);
    return { kind: 'remix', label: remixer ? `${remixer} Remix` : text, remixer };
  }
  const m = REMIX_KEYWORD.exec(text);
  if (!m) return null;
  const remixer = m[1] ? cleanRemixerName(m[1]) : undefined;
  // A bare "Edit" / "Radio Edit" is a length edit, not a remix by someone.
  if (/^edit$/i.test(m[2]) && !remixer) return null;
  return { kind: 'remix', label: text, remixer };
}

const REMIXER_TAIL_WORDS = new Set(['mix', 'version', 'dub', 'vip', 'instrumental', 'acoustic']);

function classifyPlain(rawText: string): Segment | null {
  const text = rawText.replace(/a\s+cappella/gi, 'Acapella').replace(/acappella/gi, 'Acapella');
  const raw = text.split(' ');
  const toks = raw.map(norm);
  const named = toks.filter(Boolean);
  if (!named.length) return null;

  if (named.every((t) => NOISE_WORDS.has(t))) return {};

  const isKnown = (t: string) => !!WORD_KIND[t] || NEUTRAL_WORDS.has(t) || NOISE_WORDS.has(t);

  // The trailing run of keyword words is the qualifier; anything before it names a remixer.
  let start = toks.length;
  while (start > 0 && toks[start - 1] && isKnown(toks[start - 1])) start--;
  const suffix = toks.slice(start);
  const prefix = raw.slice(0, start);
  const kinds = suffix.flatMap((t) => (WORD_KIND[t] ? [WORD_KIND[t]] : []));
  const last = toks[toks.length - 1];

  if (kinds.length) {
    const kind = KIND_PRIORITY.find((k) => kinds.includes(k))!;
    if (!prefix.length) return { kind, label: rawText };
    if (!REMIXER_TAIL_WORDS.has(last)) return null;
    if (kind === 'original') return { kind: 'other', label: rawText };
    return { kind, label: rawText, remixer: cleanRemixerName(prefix.join(' ')) };
  }

  if (!prefix.length) return suffix.some((t) => t === 'edit' || t === 'cut') ? { kind: 'radio', label: rawText } : null;

  // Unrecognised words ending in Mix/Version ("Deep Warehouse Mix"): a distinct recording of unknown type.
  if (last === 'mix' || last === 'version') return { kind: 'other', label: rawText };
  return null;
}

function classify(rawText: string, artists: string[]): Segment | null {
  const text = clean(rawText);
  if (!text) return null;

  const feat = classifyFeaturing(text, artists);
  if (feat) return feat;

  const remix = classifyRemix(text);
  if (remix) return remix;

  if (LIVE.test(text)) return { kind: 'live', label: text };

  if (REMASTER.test(text) && text.split(' ').length <= 6) return { kind: 'remaster', label: text };

  return classifyPlain(text);
}

export function parseVersion(rawTitle: string, artists: string[] = []): ParsedVersion {
  const raw = clean(rawTitle);
  const segments: Segment[] = [];

  // 1. Parenthesised / bracketed segments: drop only the ones we recognise.
  let rest = raw.replace(/\(([^()]*)\)|\[([^[\]]*)\]/g, (whole, p, b) => {
    const seg = classify(p ?? b, artists);
    if (!seg) return whole;
    segments.push(seg);
    return '';
  });

  // 2. Dash suffixes: " - Radio Edit", " – 2014 Remaster". Unrecognised parts keep their separator.
  const parts = rest.split(/(\s+[-–—]\s+)/);
  let base = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const seg = classify(parts[i + 1] ?? '', artists);
    if (seg) segments.push(seg);
    else base += parts[i] + (parts[i + 1] ?? '');
  }

  // 3. Unparenthesised "feat. X" left on the title.
  const featTail = /\s+(?:featuring|feat|ft)(?:\.\s*|\s+)(.+)$/i.exec(base);
  if (featTail) {
    segments.push({ featuring: splitNames(featTail[1]) });
    base = base.slice(0, featTail.index);
  }

  const baseTitle = clean(base) || raw;

  const kinds = segments.flatMap((s) => (s.kind ? [s.kind] : []));
  const kind: VersionKind = KIND_PRIORITY.find((k) => kinds.includes(k)) ?? 'original';
  const featuring = segments.flatMap((s) => s.featuring ?? []);
  const remixer = segments.find((s) => s.remixer)?.remixer;

  const labeled = segments
    .filter((s) => s.label && s.kind && s.kind !== 'original')
    .sort((x, y) => KIND_PRIORITY.indexOf(x.kind!) - KIND_PRIORITY.indexOf(y.kind!) || canonicalLabel(x.label!).localeCompare(canonicalLabel(y.label!)));
  const labelParts = [...new Set(labeled.map((s) => canonicalLabel(s.label!)))];
  const label = labelParts.length ? labelParts.join(', ') : undefined;

  const out: ParsedVersion = { baseTitle, kind, featuring };
  if (label) out.label = label;
  if (remixer) out.remixer = remixer;
  return out;
}
