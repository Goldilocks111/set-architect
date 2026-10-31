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

function artistParts(artist: string): string[] {
  return normalize(artist)
    .split(/\s+(?:and|x|vs)\s+|,/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function artistMatches(expected: string, actual: string): boolean {
  const have = ' ' + normalize(actual) + ' ';
  const parts = artistParts(expected);
  return parts.length > 0 && parts.some((p) => have.includes(' ' + p + ' '));
}

function titleMatches(expected: string, actual: { baseTitle?: string; title?: string }): boolean {
  const want = normalize(stripQualifier(expected));
  const raw = actual.baseTitle ?? (actual.title ? stripQualifier(actual.title) : '');
  return want !== '' && normalize(raw) === want;
}

export function isHit(
  t: BenchTrack,
  results: Array<{ artist: string; baseTitle?: string; title?: string }>,
  topN = 5,
): boolean {
  return results
    .slice(0, topN)
    .some((r) => artistMatches(t.artist, r.artist) && titleMatches(t.title, r));
}

export function versionCorrect(
  c: BenchVersionCase,
  results: Array<{ artist: string; version: ParsedVersion }>,
): boolean {
  return results.slice(0, 3).some((r) => {
    if (!artistMatches(c.expect.artist, r.artist)) return false;
    if (normalize(r.version.baseTitle) !== normalize(c.expect.baseTitle)) return false;
    if (r.version.kind !== c.expect.kind) return false;
    if (c.expect.remixer) {
      return !!r.version.remixer && normalize(r.version.remixer) === normalize(c.expect.remixer);
    }
    return true;
  });
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
