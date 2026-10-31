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
}

export interface BenchVersionCase {
  id: string;
  query: string;
  expect: { artist: string; baseTitle: string; kind: VersionKind; remixer?: string };
  /** Known recording length; when set and a result carries a duration, they must agree within DURATION_WINDOW_MS. */
  durationMs?: number;
  source: string;
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

/**
 * The expected lead artist (first comma-separated name) must equal one of the result's
 * comma-separated artists exactly. A duo name joined by "&"/"and" matches either as a whole
 * name or when every member is listed as its own artist.
 */
function artistMatches(expected: string, actual: string): boolean {
  const lead = normalize(expected.split(',')[0]);
  if (!lead) return false;
  const have = new Set(
    actual
      .replace(FEAT, ' ')
      .split(',')
      .map((p) => compact(normalize(p)))
      .filter(Boolean),
  );
  if (have.has(compact(lead))) return true;
  const members = lead.split(/ and /).map(compact).filter(Boolean);
  return members.length > 1 && members.every((m) => have.has(m));
}

function titleMatches(expected: string, actual: { baseTitle?: string; title?: string }): boolean {
  const want = normalize(expected);
  const wantBase = normalize(stripQualifier(expected));
  const got = normalize(actual.baseTitle ?? stripQualifier(actual.title ?? ''));
  return got !== '' && (got === want || got === wantBase);
}

/** Index of the first match within topN, or -1. */
export function hitRank(
  t: BenchTrack,
  results: Array<{ artist: string; baseTitle?: string; title?: string }>,
  topN = 5,
): number {
  return results.slice(0, topN).findIndex((r) => artistMatches(t.artist, r.artist) && titleMatches(t.title, r));
}

export function isHit(
  t: BenchTrack,
  results: Array<{ artist: string; baseTitle?: string; title?: string }>,
  topN = 5,
): boolean {
  return hitRank(t, results, topN) >= 0;
}

type VersionResult = { artist: string; version: ParsedVersion; durationMs?: number };

/** Index of the first result within the top 3 that is the exact expected recording, or -1. */
export function versionRank(c: BenchVersionCase, results: VersionResult[]): number {
  return results.slice(0, 3).findIndex((r) => {
    if (!artistMatches(c.expect.artist, r.artist)) return false;
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
