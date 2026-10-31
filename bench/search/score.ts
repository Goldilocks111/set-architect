import type { ParsedVersion, VersionKind } from '../../src/lib/search/types';

export interface BenchTrack {
  id: string;
  artist: string;
  title: string;
  version?: string;
  releaseYear: number;
  bucket: 'classic' | 'recent';
  query: string;
  source: string;
  /** Alternate catalog spellings per credited artist, e.g. { "Rüfüs Du Sol": ["RÜFÜS"] }. */
  aliases?: Record<string, string[]>;
}

export interface BenchVersionCase {
  id: string;
  query: string;
  expect: { artist: string; baseTitle: string; kind: VersionKind; remixer?: string };
  /** Known recording length; when set and a result carries a duration, they must agree within DURATION_WINDOW_MS. */
  durationMs?: number;
  source: string;
  aliases?: Record<string, string[]>;
}

const FEAT = /[(\[]?\s*\b(?:feat|ft|featuring)\b\.?\s[^)\]]*[)\]]?/gi;

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(FEAT, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Drops a trailing "(… Mix)" / "- … Remix" qualifier so raw provider titles compare to base titles. */
function stripQualifier(title: string): string {
  return title.replace(/\s*[(\[][^)\]]*[)\]]\s*$/, '').replace(/\s+-\s+[^-]*$/, '');
}

export const DURATION_WINDOW_MS = 10_000;

const compact = (s: string) => s.replace(/ /g, '');

export type ArtistBase = 'exact' | 'subset-with-lead' | 'subset-secondary-only' | 'alias';
/** `+extras` marks results that also credit artists outside the fixture's credited set. */
export type ArtistRule = ArtistBase | `${ArtistBase}+extras`;

/**
 * Credited fixture artists (comma-separated, lead first) map every accepted spelling to a credit index.
 * The result string is split on ",", "&", "and", "x" only where the pieces are credited artists, so a
 * credited duo such as "Above & Beyond" stays whole unless both halves are credited on their own.
 * HIT = at least one credited artist is on the result. Other credited artists may be missing (Deezer lists
 * a single artist) and extra uncredited artists may appear (iTunes joins featured artists). A credited name
 * that is merely part of a longer name ("Disclosure Fan Club") never matches. Hits that rest on a
 * non-lead credit alone are tagged 'subset-secondary-only' so they can be audited by hand.
 */
export function artistRule(
  expected: string,
  actual: string,
  aliases: Record<string, string[]> = {},
): ArtistRule | null {
  const credits = expected.split(',').map((c) => c.trim()).filter(Boolean);
  if (credits.length === 0) return null;
  const spell = new Map<string, { credit: number; alias: boolean }>();
  credits.forEach((c, i) => {
    spell.set(compact(normalize(c)), { credit: i, alias: false });
    for (const a of aliases[c] ?? []) {
      const k = compact(normalize(a));
      if (!spell.has(k)) spell.set(k, { credit: i, alias: true });
    }
  });

  // credited names that themselves contain a delimiter are re-joined from adjacent pieces (longest first)
  const joined = actual
    .replace(FEAT, ' ')
    .split(/\s*(?:,|&|\band\b|\bx\b)\s*/i).map((w) => normalize(w)).filter(Boolean);
  const found = new Map<number, boolean>();
  let extras = false;
  let i = 0;
  while (i < joined.length) {
    let took = false;
    for (let len = joined.length - i; len >= 1 && !took; len--) {
      const key = compact(joined.slice(i, i + len).join(' and '));
      const hit = spell.get(key);
      if (hit) {
        found.set(hit.credit, (found.get(hit.credit) ?? false) || hit.alias);
        i += len;
        took = true;
      }
    }
    if (!took) {
      extras = true;
      i++;
    }
  }
  if (found.size === 0) return null;
  const base: ArtistBase = [...found.values()].some(Boolean)
    ? 'alias'
    : found.size === credits.length
      ? 'exact'
      : found.has(0)
        ? 'subset-with-lead'
        : 'subset-secondary-only';
  return extras ? `${base}+extras` : base;
}

function artistMatches(expected: string, actual: string, aliases?: Record<string, string[]>): boolean {
  return artistRule(expected, actual, aliases) !== null;
}

const SOUNDTRACK_TAG = /\s*[(\[]\s*from\b[^)\]]*[)\]]/gi;

function titleMatches(expected: string, actual: { baseTitle?: string; title?: string }): boolean {
  const clean = (s: string) => normalize(s.replace(SOUNDTRACK_TAG, ' '));
  const want = clean(expected);
  const wantBase = clean(stripQualifier(expected));
  const got = clean(actual.baseTitle ?? stripQualifier(actual.title ?? ''));
  return got !== '' && (got === want || got === wantBase);
}

/** Index of the first match within topN, and which artist rule accepted it. */
export function hitDetail(
  t: BenchTrack,
  results: Array<{ artist: string; baseTitle?: string; title?: string }>,
  topN = 5,
): { rank: number; via: ArtistRule } | null {
  const top = results.slice(0, topN);
  for (let i = 0; i < top.length; i++) {
    const via = artistRule(t.artist, top[i].artist, t.aliases);
    if (via && titleMatches(t.title, top[i])) return { rank: i, via };
  }
  return null;
}

/** Index of the first match within topN, or -1. */
export function hitRank(
  t: BenchTrack,
  results: Array<{ artist: string; baseTitle?: string; title?: string }>,
  topN = 5,
): number {
  return hitDetail(t, results, topN)?.rank ?? -1;
}

export function isHit(
  t: BenchTrack,
  results: Array<{ artist: string; baseTitle?: string; title?: string }>,
  topN = 5,
): boolean {
  return hitDetail(t, results, topN) !== null;
}

type VersionResult = { artist: string; version: ParsedVersion; durationMs?: number };

/** Index of the first result within the top 3 that is the exact expected recording, or -1. */
export function versionRank(c: BenchVersionCase, results: VersionResult[]): number {
  return results.slice(0, 3).findIndex((r) => {
    if (!artistMatches(c.expect.artist, r.artist, c.aliases)) return false;
    if (normalize(r.version.baseTitle) !== normalize(c.expect.baseTitle)) return false;
    if (r.version.kind !== c.expect.kind) return false;
    if (c.expect.remixer) {
      if (!r.version.remixer || normalize(r.version.remixer) !== normalize(c.expect.remixer)) return false;
    }
    if (c.durationMs !== undefined && r.durationMs !== undefined) {
      if (Math.abs(r.durationMs - c.durationMs) > DURATION_WINDOW_MS) return false;
    }
    return true;
  });
}

export function versionCorrect(c: BenchVersionCase, results: VersionResult[]): boolean {
  return versionRank(c, results) >= 0;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
