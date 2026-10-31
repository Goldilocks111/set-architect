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
  'instrumental', 'tv', 'main', 'long', 'full', 'dub', 'official',
]);

const REMIX_KEYWORD = /^(?:(.*?)\s+)?(remix|rework|bootleg|flip|refix|re-?edit|mashup|edit)$/i;
const REMIX_BY = /^(?:remix(?:ed)?|rework(?:ed)?|edit(?:ed)?)\s+by\s+(.+)$/i;
const FEATURING = /^(?:(?:featuring|feat\.?|ft\.?)\s*|(?:with)\s+|w\/\s*)(.+)$/i;
const FEATURING_STRONG = /^(?:featuring|feat\.?|ft\.?)(?:\s+|$)/i;
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

function splitNames(s: string): string[] {
  return s.split(',').map(clean).filter(Boolean);
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/a\s+cappella/g, 'acapella')
    .replace(/acappella/g, 'acapella')
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(Boolean);
}

function cleanRemixerName(raw: string): string | undefined {
  const toks = clean(raw.replace(/['’]s$/i, '')).split(' ').filter(Boolean);
  while (toks.length && MODIFIER_WORDS.has(toks[toks.length - 1].toLowerCase())) toks.pop();
  return toks.length ? toks.join(' ') : undefined;
}

function classifyFeaturing(text: string): Segment | null {
  const m = FEATURING.exec(text);
  if (!m) return null;
  const names = splitNames(m[1]);
  if (!names.length) return null;
  if (!FEATURING_STRONG.test(text)) {
    // "with"/"w/" are ambiguous: require something shaped like a name.
    const first = names[0];
    if (/^[a-z]/.test(first)) return null;
    if (NOT_A_FEATURED_NAME.has(first.split(' ')[0].toLowerCase())) return null;
  }
  return { featuring: names };
}

function classifyRemix(text: string): Segment | null {
  const by = REMIX_BY.exec(text);
  if (by) {
    const remixer = cleanRemixerName(by[1]);
    return { kind: 'remix', label: text, remixer };
  }
  const m = REMIX_KEYWORD.exec(text);
  if (!m) return null;
  const remixer = m[1] ? cleanRemixerName(m[1]) : undefined;
  // A bare "Edit" / "Radio Edit" is a length edit, not a remix by someone.
  if (/^edit$/i.test(m[2]) && !remixer) return null;
  return { kind: 'remix', label: text, remixer };
}

function classifyPlain(text: string): Segment | null {
  const toks = words(text);
  if (!toks.length) return null;

  if (toks.every((t) => NOISE_WORDS.has(t))) return {};

  const kinds: VersionKind[] = [];
  let unknown = false;
  let hasEditWord = false;
  for (const t of toks) {
    if (t === 'edit' || t === 'cut') hasEditWord = true;
    if (WORD_KIND[t]) kinds.push(WORD_KIND[t]);
    else if (!NEUTRAL_WORDS.has(t)) unknown = true;
  }

  if (!unknown) {
    if (kinds.length) {
      const kind = KIND_PRIORITY.find((k) => kinds.includes(k))!;
      return { kind, label: text };
    }
    // Only neutral words: "Edit"/"Cut" is a radio edit; bare "Mix"/"Version" is not informative.
    return hasEditWord ? { kind: 'radio', label: text } : null;
  }

  // Unrecognised words ending in Mix/Version ("Deep Warehouse Mix"): a distinct recording of unknown type.
  const last = toks[toks.length - 1];
  if (last === 'mix' || last === 'version') return { kind: 'other', label: text };
  return null;
}

function classify(rawText: string): Segment | null {
  const text = clean(rawText);
  if (!text) return null;

  const feat = classifyFeaturing(text);
  if (feat) return feat;

  const remix = classifyRemix(text);
  if (remix) return remix;

  if (LIVE.test(text)) return { kind: 'live', label: text };

  if (REMASTER.test(text) && words(text).length <= 6) return { kind: 'remaster', label: text };

  return classifyPlain(text);
}

export function parseVersion(rawTitle: string, _artists?: string[]): ParsedVersion {
  const raw = clean(rawTitle);
  const segments: Segment[] = [];

  // 1. Parenthesised / bracketed segments: drop only the ones we recognise.
  let rest = raw.replace(/\(([^()]*)\)|\[([^[\]]*)\]/g, (whole, p, b) => {
    const seg = classify(p ?? b);
    if (!seg) return whole;
    segments.push(seg);
    return '';
  });

  // 2. Dash suffixes: " - Radio Edit", " – 2014 Remaster". Unrecognised parts keep their separator.
  const parts = rest.split(/(\s+[-–—]\s+)/);
  let base = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const seg = classify(parts[i + 1] ?? '');
    if (seg) segments.push(seg);
    else base += parts[i] + (parts[i + 1] ?? '');
  }

  // 3. Unparenthesised "feat. X" left on the title.
  const featTail = /\s+(?:featuring|feat\.?|ft\.?)\s+(.+)$/i.exec(base);
  if (featTail) {
    segments.push({ featuring: splitNames(featTail[1]) });
    base = base.slice(0, featTail.index);
  }

  const baseTitle = clean(base) || raw;

  const kinds = segments.flatMap((s) => (s.kind ? [s.kind] : []));
  const kind: VersionKind = KIND_PRIORITY.find((k) => kinds.includes(k)) ?? 'original';
  const featuring = segments.flatMap((s) => s.featuring ?? []);
  const remixer = segments.find((s) => s.kind === 'remix' && s.remixer)?.remixer;

  const labelParts = segments.flatMap((s) => (s.label && s.kind && s.kind !== 'original' ? [s.label] : []));
  const label = labelParts.length ? labelParts.join(', ') : undefined;

  const out: ParsedVersion = { baseTitle, kind, featuring };
  if (label) out.label = label;
  if (remixer) out.remixer = remixer;
  return out;
}
