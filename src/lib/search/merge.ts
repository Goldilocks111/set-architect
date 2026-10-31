import { withTimeout } from '@/lib/http';
import { cooldownUntil, recordFailure, recordSuccess, resetBreakers } from './breaker';
import { searchProviders } from './providers';
import { parseVersion } from './version';
import type { MergedHit, MergedSearchResponse, ParsedVersion, SearchProvider, SearchResult, VersionKind } from './types';

export const PROVIDER_TIMEOUT_MS = 1200;

/**
 * Calls allowed per provider per rolling minute. Apple documents roughly 20/min for the iTunes Search API
 * and answers 403/429 for minutes after it is exceeded, so we stop asking before that happens.
 */
const PER_MINUTE_BUDGET: Partial<Record<SearchResult['provider'], number>> = { itunes: 20 };
const recentCalls = new Map<string, number[]>();

function takeBudget(name: SearchResult['provider'], now = Date.now()): boolean {
  const limit = PER_MINUTE_BUDGET[name];
  if (limit === undefined) return true;
  const calls = (recentCalls.get(name) ?? []).filter((t) => now - t < 60_000);
  if (calls.length >= limit) {
    recentCalls.set(name, calls);
    return false;
  }
  calls.push(now);
  recentCalls.set(name, calls);
  return true;
}

export function resetProviderBudgets(): void {
  recentCalls.clear();
  resetBreakers();
}

/** Two recordings with the same name but lengths further apart than this are different edits. */
const DURATION_TOLERANCE_MS = 8000;

const LETTER_FOLDS: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' };

/** Lowercase, accent-free, punctuation-free form used for every comparison ("Rüfüs Du Sol" -> "rufus du sol"). */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[øæœßđðłþı]/g, (c) => LETTER_FOLDS[c])
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const compact = (s: string) => fold(s).replace(/ /g, '');
const tokens = (s: string) => fold(s).split(' ').filter(Boolean);

const ARTIST_SPLIT = /\s*(?:,|;|\/|&|\+|\s(?:x|and|vs\.?|feat\.?|ft\.?|featuring|with)\s)\s*/i;

/** Individual artist names, folded: "CamelPhat & Elderbrook" -> ["camelphat", "elderbrook"]. */
function artistNames(r: Pick<SearchResult, 'artist' | 'artists'>): string[] {
  const raw = [r.artist, ...r.artists].flatMap((a) => a.split(ARTIST_SPLIT));
  return [...new Set(raw.map(fold).filter(Boolean))];
}

const partKindCache = new Map<string, VersionKind>();
function partKind(part: string): VersionKind {
  let k = partKindCache.get(part);
  if (!k) {
    k = parseVersion(`x (${part})`).kind;
    partKindCache.set(part, k);
  }
  return k;
}

/** Kinds named by each part of a label: "Four Tet Remix, Extended" -> ["remix", "extended"]. */
function labelKinds(v: ParsedVersion): VersionKind[] {
  return v.label ? v.label.split(', ').map(partKind) : [];
}

/**
 * What distinguishes recordings of one kind beyond kind + remixer (ruling R5): an "other" mix is
 * identified by its own label, and modifiers such as "Extended" on a remix make it a different cut.
 */
function versionSignature(v: ParsedVersion): string {
  if (v.kind === 'other') return fold(v.label ?? '');
  return [...new Set(labelKinds(v).filter((k) => k !== v.kind))].sort().join('+');
}

/** Release-context tags that are not part of the work's name: "Pusher [From GTAVI: Original Score]", "X - From \"Barbie\"". */
const SOURCE_TAG = /\s*(?:[([](?:from|taken from)\s[^)\]]*[)\]]|\s[-–—]\s(?:from|taken from)\s.*$)/gi;

function withoutSourceTag(r: SearchResult): SearchResult {
  const baseTitle = r.version.baseTitle.replace(SOURCE_TAG, '').trim();
  return baseTitle && baseTitle !== r.version.baseTitle ? { ...r, version: { ...r.version, baseTitle } } : r;
}

const KIND_SPECIFICITY = (k: VersionKind) => (k === 'original' ? 0 : 1);

interface Member {
  r: SearchResult;
  rank: number;
  total: number;
}

interface Group {
  members: Member[];
  version: ParsedVersion;
  names: Set<string>;
  isrcs: Set<string>;
  durationMs?: number;
}

function sameVersion(a: ParsedVersion, b: ParsedVersion): boolean {
  return (
    fold(a.baseTitle) === fold(b.baseTitle) &&
    a.kind === b.kind &&
    fold(a.remixer ?? '') === fold(b.remixer ?? '') &&
    versionSignature(a) === versionSignature(b)
  );
}

function artistsOverlap(names: Set<string>, other: string[]): boolean {
  if (other.some((n) => names.has(n))) return true;
  const a = [...names].map((n) => n.replace(/ /g, '')).join('');
  return other.some((n) => {
    const c = n.replace(/ /g, '');
    return c.length >= 4 && a.includes(c);
  });
}

const durationsAgree = (a?: number, b?: number) => a === undefined || b === undefined || Math.abs(a - b) <= DURATION_TOLERANCE_MS;

function groupResults(members: Member[]): Group[] {
  const groups: Group[] = [];
  for (const m of members) {
    const names = artistNames(m.r);
    const isrc = m.r.isrc?.toUpperCase();
    const g =
      (isrc && groups.find((x) => x.isrcs.has(isrc))) ||
      groups.find(
        (x) => sameVersion(x.version, m.r.version) && artistsOverlap(x.names, names) && durationsAgree(x.durationMs, m.r.durationMs)
      );
    if (!g) {
      groups.push({
        members: [m],
        version: m.r.version,
        names: new Set(names),
        isrcs: new Set(isrc ? [isrc] : []),
        durationMs: m.r.durationMs,
      });
      continue;
    }
    g.members.push(m);
    names.forEach((n) => g.names.add(n));
    if (isrc) g.isrcs.add(isrc);
    g.durationMs ??= m.r.durationMs;
    // Same ISRC with a different title: the more specific description of the recording wins.
    if (KIND_SPECIFICITY(m.r.version.kind) > KIND_SPECIFICITY(g.version.kind)) g.version = m.r.version;
  }
  return groups;
}

// ---- query intent -------------------------------------------------------------------------------

const VERSION_WORDS: Record<string, VersionKind> = {
  extended: 'extended',
  club: 'extended',
  radio: 'radio',
  remix: 'remix',
  rework: 'remix',
  bootleg: 'remix',
  flip: 'remix',
  refix: 'remix',
  original: 'original',
  dub: 'dub',
  vip: 'vip',
  live: 'live',
  acoustic: 'acoustic',
  instrumental: 'instrumental',
  remaster: 'remaster',
  remastered: 'remaster',
};

const QUALIFIER_WORDS = new Set([...Object.keys(VERSION_WORDS), 'mix', 'edit', 'version', 'cut']);

/**
 * Deezer matches every query word against the title proper and ignores its title_version, so
 * "Cola Radio Edit" finds nothing; it gets the query without the trailing qualifier ("Cola") and
 * ranking picks the asked version. Only a trailing run is dropped, so "Radio Ga Ga" survives.
 */
export function providerQuery(name: SearchResult['provider'], query: string): string {
  if (name !== 'deezer') return query;
  const words = query.trim().split(/\s+/);
  let end = words.length;
  while (end > 0 && QUALIFIER_WORDS.has(fold(words[end - 1]))) end--;
  return end > 0 && end < words.length ? words.slice(0, end).join(' ') : query;
}

/** Query words that never identify a track on their own. */
const FILLER = new Set(['mix', 'edit', 'version', 'feat', 'ft', 'featuring', 'and', 'with', 'x', 'vs', 'the', 'a']);

interface Query {
  tokens: string[];
  set: Set<string>;
  compact: string;
}

function parseQuery(q: string): Query {
  const t = tokens(q);
  return { tokens: t, set: new Set(t), compact: t.join('') };
}

/** True when every word of `phrase` is in the query (or, for longer names, its spaceless form is). */
function inQuery(q: Query, phrase: string): boolean {
  const t = tokens(phrase);
  if (!t.length) return false;
  if (t.every((w) => q.set.has(w))) return true;
  const c = t.join('');
  return c.length >= 4 && q.compact.includes(c);
}

// ---- scoring ------------------------------------------------------------------------------------

const UNASKED_VERSION_BONUS: Partial<Record<VersionKind, number>> = { original: 8, extended: 5, radio: 4, remaster: 3 };

interface Assessment {
  score: number;
  /** Artist and title both named in the query. */
  work: boolean;
  /** Every query word explained and every asked version present: nothing better can be found. */
  strong: boolean;
  /** Folded words that name this work (artists + title). */
  workWords: Set<string>;
}

function assess(g: Group, q: Query, hit: Omit<MergedHit, 'score' | 'key'>): Assessment | null {
  const v = g.version;
  const names = [...g.names];
  const titleWords = new Set(tokens(v.baseTitle));
  const hitWords = new Set([...titleWords, ...names.flatMap(tokens), ...v.featuring.flatMap(tokens), ...tokens(v.remixer ?? '')]);
  const hitCompact = [...hitWords].join('');

  const artistMatch = names.some((n) => inQuery(q, n));
  const titleMatch = inQuery(q, v.baseTitle);

  // Version words that are part of this hit's own name ("Live Without Love") are not a version request.
  const asked = new Set(
    q.tokens.filter((w) => VERSION_WORDS[w] && !hitWords.has(w)).map((w) => VERSION_WORDS[w])
  );
  const content = q.tokens.filter((w) => !FILLER.has(w) && !(VERSION_WORDS[w] && !hitWords.has(w)));
  const covered = content.filter((w) => hitWords.has(w) || (w.length >= 3 && hitCompact.includes(w))).length;
  const coverage = content.length ? covered / content.length : 0;

  if (!artistMatch && !titleMatch && coverage === 0) return null;

  let s = 30 * coverage;
  if (artistMatch && titleMatch) s += coverage === 1 ? 100 : 60;
  else if (titleMatch) s += 30;
  else if (artistMatch) s += 15;

  const kinds = new Set([v.kind, ...labelKinds(v)]);
  if (asked.size) {
    for (const k of asked) s += kinds.has(k) ? 25 : -15;
    if (asked.has('remix') && v.remixer && inQuery(q, v.remixer)) s += 20;
  } else {
    s += UNASKED_VERSION_BONUS[v.kind] ?? 0;
  }

  // Each provider's own ordering is relevance evidence (Spotify reports no popularity in dev mode).
  const bestRank = new Map<string, number>();
  for (const m of g.members) {
    const b = 6 * (1 - m.rank / Math.max(m.total, 10));
    bestRank.set(m.r.provider, Math.max(bestRank.get(m.r.provider) ?? 0, b));
  }
  for (const b of bestRank.values()) s += b;

  s += (hit.popularity ?? 0) * 0.08;
  const year = hit.releaseDate ? parseInt(hit.releaseDate.slice(0, 4), 10) : NaN;
  if (Number.isFinite(year)) s += 2 * Math.min(1, Math.max(0, (year - 1980) / 46));
  const work = artistMatch && titleMatch;
  return {
    score: Math.round(s * 100) / 100,
    work,
    strong: work && coverage === 1 && [...asked].every((k) => kinds.has(k)),
    workWords: new Set([...titleWords, ...names.flatMap(tokens)]),
  };
}

function pick<K extends keyof SearchResult>(ms: Member[], field: K, order: SearchResult['provider'][]): SearchResult[K] | undefined {
  for (const p of order) {
    const m = ms.find((x) => x.r.provider === p && x.r[field] !== undefined);
    if (m) return m.r[field];
  }
  return undefined;
}

function toHit(g: Group): Omit<MergedHit, 'score'> {
  const ms = g.members;
  const v = g.version;
  const isrc = [...g.isrcs][0];
  const primary = ms[0].r;
  const hit: Omit<MergedHit, 'score'> = {
    key: isrc ?? [fold(primary.artists[0] ?? primary.artist), fold(v.baseTitle), v.kind, fold(v.remixer ?? ''), versionSignature(v)].join('|'),
    artist: primary.artist,
    baseTitle: v.baseTitle,
    version: v,
    providers: [...new Set(ms.map((m) => m.r.provider))],
  };
  const pops = ms.flatMap((m) => (m.r.popularity === undefined ? [] : [m.r.popularity]));
  const fields: Partial<MergedHit> = {
    isrc,
    durationMs: g.durationMs,
    releaseDate: pick(ms, 'releaseDate', ['spotify', 'itunes', 'deezer']),
    popularity: pops.length ? Math.max(...pops) : undefined,
    artworkUrl: pick(ms, 'artworkUrl', ['spotify', 'itunes', 'deezer']),
    // iTunes previews are stable; Deezer's are signed and expire within minutes.
    previewUrl: pick(ms, 'previewUrl', ['itunes', 'deezer', 'spotify']),
    spotifyId: pick(ms, 'spotifyId', ['spotify']),
    spotifyUrl: pick(ms, 'spotifyUrl', ['spotify']),
  };
  for (const [k, val] of Object.entries(fields)) if (val !== undefined) (hit as Record<string, unknown>)[k] = val;
  return hit;
}

/** Orders works by their best version and keeps every version of a work next to each other. */
function groupByWork(hits: MergedHit[]): MergedHit[] {
  const works: Array<{ title: string; names: Set<string>; hits: MergedHit[] }> = [];
  for (const h of hits) {
    const title = fold(h.baseTitle);
    const names = artistNames({ artist: h.artist, artists: [] });
    const w = works.find((x) => x.title === title && artistsOverlap(x.names, names));
    if (w) w.hits.push(h);
    else works.push({ title, names: new Set(names), hits: [h] });
  }
  return works.flatMap((w) => w.hits);
}

/** SEARCH_PROVIDERS="spotify,deezer" restricts the default set (ops/benchmark knob); unset means all. */
function defaultProviders(): SearchProvider[] {
  const allow = process.env.SEARCH_PROVIDERS?.split(',').map((s) => s.trim()).filter(Boolean);
  return allow?.length ? searchProviders.filter((p) => allow.includes(p.name)) : searchProviders;
}

interface Ranked {
  hit: MergedHit;
  a: Assessment;
}

function rank(members: Member[], q: Query): Ranked[] {
  const out: Ranked[] = [];
  for (const g of groupResults(members)) {
    const hit = toHit(g);
    const a = assess(g, q, hit);
    if (a) out.push({ hit: { ...hit, score: a.score }, a });
  }
  return out.sort((x, y) => y.hit.score - x.hit.score);
}

/**
 * A narrower second query once the first round has identified the work: its title plus the query words
 * that are not part of it. "CamelPhat Elderbrook Cola ZHU Remix" -> "Cola ZHU Remix", which Spotify finds
 * even though its credit for that remix leaves Elderbrook out.
 */
function refinedQuery(query: string, ranked: Ranked[]): string | undefined {
  const best = ranked.find((r) => r.a.work);
  if (!best) return undefined;
  const leftover = query.split(/\s+/).filter((w) => {
    const t = tokens(w);
    return t.length > 0 && !t.every((x) => best.a.workWords.has(x));
  });
  if (!leftover.length) return undefined;
  const refined = `${best.hit.baseTitle} ${leftover.join(' ')}`;
  return fold(refined) === fold(query) ? undefined : refined;
}

export async function mergedSearch(
  query: string,
  opts: { providers?: SearchProvider[]; timeoutMs?: number } = {}
): Promise<MergedSearchResponse> {
  const providers = (opts.providers ?? defaultProviders()).filter((p) => p.configured());
  const timeoutMs = opts.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const degraded = new Set<SearchResult['provider']>();
  const q = parseQuery(query);

  const ask = async (calls: Array<[SearchProvider, string]>): Promise<Member[]> => {
    const answers = await Promise.all(
      calls.map(async ([p, text]) => {
        try {
          if (cooldownUntil(p.name)) throw new Error(`${p.name} cooling down after throttling`);
          if (!takeBudget(p.name)) throw new Error(`${p.name} over its request budget`);
          const rs = await withTimeout(p.search(providerQuery(p.name, text)), timeoutMs, `${p.name} search`);
          recordSuccess(p.name);
          return rs;
        } catch (err) {
          recordFailure(p.name, err);
          degraded.add(p.name);
          return [];
        }
      })
    );
    return answers.flatMap((rs) => rs.map((r, i) => ({ r: withoutSourceTag(r), rank: i, total: rs.length })));
  };

  // Rate-limited providers are held back for queries the others could not fully answer.
  const primary = providers.filter((p) => PER_MINUTE_BUDGET[p.name] === undefined);
  const scarce = providers.filter((p) => PER_MINUTE_BUDGET[p.name] !== undefined);

  let members = await ask(primary.map((p) => [p, query]));
  let ranked = rank(members, q);
  if (!ranked.some((r) => r.a.strong)) {
    const refined = refinedQuery(query, ranked);
    const calls: Array<[SearchProvider, string]> = scarce.map((p) => [p, query]);
    if (refined) calls.push(...primary.map((p): [SearchProvider, string] => [p, refined]));
    if (calls.length) {
      members = members.concat(await ask(calls));
      ranked = rank(members, q);
    }
  }

  return {
    hits: groupByWork(ranked.map((r) => r.hit)),
    degraded: providers.map((p) => p.name).filter((n) => degraded.has(n)),
  };
}
