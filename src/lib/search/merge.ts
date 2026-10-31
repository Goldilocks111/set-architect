import { withTimeout } from '@/lib/http';
import { cooldownUntil, recordFailure, recordSuccess, resetBreakers } from './breaker';
import { searchProviders } from './providers';
import { musicbrainzWorkQuery } from './providers/musicbrainz';
import { parseVersion } from './version';
import type { MergedHit, MergedSearchResponse, ParsedVersion, SearchProvider, SearchResult, VersionKind } from './types';

export const PROVIDER_TIMEOUT_MS = 1200;
/** MusicBrainz answered in 300–2100ms when probed; it only runs in round two, for version discovery. */
export const PROVIDER_TIMEOUTS: Partial<Record<SearchResult['provider'], number>> = { musicbrainz: 2500 };

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

/** Separators that always join different acts. "&" / "and" are not among them: "Above & Beyond" is one act. */
const COLLAB_SPLIT = /\s*(?:,|;|\/|\+|\s(?:x|vs\.?|feat\.?|ft\.?|featuring|with)\s)\s*/i;

interface ArtistNames {
  /** Whole act names: "camelphat", "above and beyond". */
  strong: Set<string>;
  /** Parts of an "&"/"and" name, which may be one act or a collaboration: "above", "beyond". */
  weak: Set<string>;
}

function artistNamesOf(credits: string[]): ArtistNames {
  const strong = new Set<string>();
  const weak = new Set<string>();
  for (const part of credits.flatMap((a) => a.split(COLLAB_SPLIT))) {
    const name = fold(part);
    if (!name) continue;
    strong.add(name);
    if (name.includes(' and ')) name.split(' and ').filter(Boolean).forEach((w) => weak.add(w));
  }
  return { strong, weak };
}

const artistNames = (r: Pick<SearchResult, 'artist' | 'artists'>) => artistNamesOf([r.artist, ...r.artists]);
const allNames = (n: ArtistNames) => [...n.strong, ...n.weak];

/**
 * 'strong' when a whole name is shared, the spaceless credits are equal, or an "&" credit's parts are a
 * multi-artist credit's names ("CamelPhat & Elderbrook" vs ["CamelPhat", "Elderbrook"]). 'weak' when only a
 * part of an "&" name equals a lone act, which is either a collaboration credited to its lead ("MEDUZA &
 * Goodboys" vs "MEDUZA") or a different act ("Above & Beyond" vs "Beyond"); callers then demand matching
 * lengths. There is no substring rule: "Elle" is not "Elle King", "Kygo" is not "Kygo Tribute".
 */
function artistsOverlap(a: ArtistNames, aCredits: Set<string>, b: ArtistNames, bCredit: string): 'strong' | 'weak' | false {
  if ([...b.strong].some((n) => a.strong.has(n))) return 'strong';
  if (bCredit !== '' && aCredits.has(bCredit)) return 'strong';
  const parts = (x: ArtistNames, y: ArtistNames) => [...x.weak].filter((n) => y.strong.has(n)).length;
  if ((b.strong.size >= 2 && parts(a, b) >= 2) || (a.strong.size >= 2 && parts(b, a) >= 2)) return 'strong';
  if (a.weak.size > 0 && a.weak.size === b.weak.size && [...b.weak].every((n) => a.weak.has(n))) return 'strong';
  return parts(a, b) > 0 || parts(b, a) > 0 ? 'weak' : false;
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
  // Read modifiers from the label's words, not its comma parts: "ARTBAT Extended Remix" is one part.
  const remixerWords = new Set(tokens(v.remixer ?? ''));
  const mods = tokens(v.label ?? '')
    .filter((w) => !remixerWords.has(w))
    .map((w) => VERSION_WORDS[w])
    .filter((k) => k && k !== v.kind);
  return [...new Set(mods)].sort().join('+');
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
  names: ArtistNames;
  /** Each member's whole credit, spaceless: "Mark, Knight" and "Mark Knight" both give "markknight". */
  credits: Set<string>;
  /** Folded first artist of each member. */
  leads: Set<string>;
  /** ISRCs from streaming providers: a different one here means a different recording (except R14). */
  isrcs: Set<string>;
  /** Every ISRC seen, including all of MusicBrainz's: any shared one proves the same recording. */
  anyIsrcs: Set<string>;
  durationMs?: number;
  durations: number[];
}

function sameVersion(a: ParsedVersion, b: ParsedVersion): boolean {
  return (
    fold(a.baseTitle) === fold(b.baseTitle) &&
    a.kind === b.kind &&
    fold(a.remixer ?? '') === fold(b.remixer ?? '') &&
    versionSignature(a) === versionSignature(b)
  );
}

const creditOf = (r: Pick<SearchResult, 'artist' | 'artists'>) => compact(r.artists.length ? r.artists.join(' ') : r.artist);
const leadOf = (r: Pick<SearchResult, 'artist' | 'artists'>) => fold(r.artists[0] ?? r.artist);

const durationsAgree = (a?: number, b?: number) => a === undefined || b === undefined || Math.abs(a - b) <= DURATION_TOLERANCE_MS;

/** Ruling R14: a re-release or duplicate upload keeps the recording but may get a new ISRC. */
const RERELEASE_TOLERANCE_MS = 2000;

/** MusicBrainz lists every ISRC a recording was ever released under; the contract field holds the first. */
export type SearchResultWithIsrcs = SearchResult & { isrcs?: string[] };

function isrcsOf(r: SearchResult): string[] {
  const all = [r.isrc, ...((r as SearchResultWithIsrcs).isrcs ?? [])].filter((x): x is string => !!x);
  return [...new Set(all.map((x) => x.toUpperCase()))];
}

const isCatalogOnly = (g: Group) => g.members.every((m) => m.r.provider === 'musicbrainz');

function groupResults(members: Member[]): Group[] {
  const groups: Group[] = [];
  for (const m of members) {
    const names = artistNames(m.r);
    const credit = creditOf(m.r);
    const lead = leadOf(m.r);
    const isrcs = isrcsOf(m.r);
    // MusicBrainz ISRCs often come from other releases: evidence for a merge, never a reason against one.
    const blocking = m.r.provider === 'musicbrainz' ? undefined : m.r.isrc?.toUpperCase();
    const d = m.r.durationMs;
    const g =
      groups.find((x) => isrcs.some((i) => x.anyIsrcs.has(i))) ||
      groups.find((x) => {
        if (!sameVersion(x.version, m.r.version)) return false;
        const overlap = artistsOverlap(x.names, x.credits, names, credit);
        if (!overlap) return false;
        if (overlap === 'weak' && !(d !== undefined && x.durationMs !== undefined && Math.abs(d - x.durationMs) <= RERELEASE_TOLERANCE_MS)) return false;
        if (blocking && x.isrcs.size && !x.isrcs.has(blocking)) {
          // two different streaming ISRCs: only a same-artist re-release of identical length merges
          return x.leads.has(lead) && d !== undefined && x.durationMs !== undefined && Math.abs(d - x.durationMs) <= RERELEASE_TOLERANCE_MS;
        }
        return durationsAgree(x.durationMs, d);
      });
    if (!g) {
      groups.push({
        members: [m],
        version: m.r.version,
        names,
        credits: new Set([credit]),
        leads: new Set([lead]),
        isrcs: new Set(blocking ? [blocking] : []),
        anyIsrcs: new Set(isrcs),
        durationMs: d,
        durations: d === undefined ? [] : [d],
      });
      continue;
    }
    g.members.push(m);
    names.strong.forEach((n) => g.names.strong.add(n));
    names.weak.forEach((n) => g.names.weak.add(n));
    g.credits.add(credit);
    g.leads.add(lead);
    if (blocking) g.isrcs.add(blocking);
    isrcs.forEach((i) => g.anyIsrcs.add(i));
    g.durationMs ??= d;
    if (d !== undefined) g.durations.push(d);
    // Same ISRC with a different title: the more specific description of the recording wins; between two
    // originals the label-less form wins, so the chip does not depend on which provider answered first.
    const mk = KIND_SPECIFICITY(m.r.version.kind);
    const gk = KIND_SPECIFICITY(g.version.kind);
    if (mk > gk || (mk === 0 && gk === 0 && g.version.label && !m.r.version.label)) g.version = m.r.version;
  }
  // A catalog-only copy of a version a streaming provider already returned adds nothing but a duplicate row.
  return groups.filter(
    (g) =>
      !isCatalogOnly(g) ||
      !groups.some(
        (x) =>
          x !== g &&
          !isCatalogOnly(x) &&
          sameVersion(x.version, g.version) &&
          artistsOverlap(x.names, x.credits, g.names, [...g.credits][0] ?? '') === 'strong' &&
          durationsAgree(x.durationMs, g.durationMs)
      )
  );
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
  const names = allNames(g.names);
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
  // Catalog-only recordings identify a real version but cannot be streamed: a streamable equivalent goes first.
  if (g.members.every((m) => m.r.provider === 'musicbrainz')) s -= 10;

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
  const isrc = [...g.isrcs][0] ?? [...g.anyIsrcs][0];
  const primary = ms[0].r;
  const hit: Omit<MergedHit, 'score'> = {
    key:
      isrc ??
      [
        fold(primary.artists[0] ?? primary.artist),
        fold(v.baseTitle),
        v.kind,
        fold(v.remixer ?? ''),
        versionSignature(v),
        // recordings split only by length (radio-length vs full-length originals) need distinct keys
        g.durations.length ? `d${Math.round(Math.min(...g.durations) / 10_000) * 10}` : '',
      ].join('|'),
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

/** Keys feed Track ids, so any remaining collision (e.g. two artists' groups with one lead) gets a suffix. */
export function uniqueKeys(hits: MergedHit[]): MergedHit[] {
  const seen = new Map<string, number>();
  return hits.map((h) => {
    const n = seen.get(h.key) ?? 0;
    seen.set(h.key, n + 1);
    return n ? { ...h, key: `${h.key}#${n + 1}` } : h;
  });
}

/** Orders works by their best version and keeps every version of a work next to each other. */
function groupByWork(hits: MergedHit[]): MergedHit[] {
  const works: Array<{ title: string; names: ArtistNames; credits: Set<string>; hits: MergedHit[] }> = [];
  for (const h of hits) {
    const title = fold(h.baseTitle);
    const names = artistNamesOf([h.artist]);
    const credit = compact(h.artist);
    const w = works.find((x) => x.title === title && artistsOverlap(x.names, x.credits, names, credit));
    if (w) w.hits.push(h);
    else works.push({ title, names, credits: new Set([credit]), hits: [h] });
  }
  return works.flatMap((w) => w.hits);
}

/** SEARCH_PROVIDERS="spotify,deezer" restricts the default set (ops/benchmark knob); unset means all. */
export function defaultProviders(): SearchProvider[] {
  const allow = process.env.SEARCH_PROVIDERS?.split(',').map((s) => s.trim()).filter(Boolean);
  return allow?.length ? searchProviders.filter((p) => allow.includes(p.name)) : searchProviders;
}

interface Ranked {
  hit: MergedHit;
  a: Assessment;
  /** First artist as the provider credited it ("Tyler, The Creator" stays whole). */
  lead: string;
}

function rank(members: Member[], q: Query): Ranked[] {
  const out: Ranked[] = [];
  for (const g of groupResults(members)) {
    const hit = toHit(g);
    const a = assess(g, q, hit);
    if (a) out.push({ hit: { ...hit, score: a.score }, a, lead: g.members[0].r.artists[0] ?? g.members[0].r.artist });
  }
  return out.sort((x, y) => y.hit.score - x.hit.score);
}

/** The best first-round hit naming both artist and title, and the query words that are not part of it. */
function identifiedWork(query: string, ranked: Ranked[]): { best: Ranked; leftover: string[] } | undefined {
  const best = ranked.find((r) => r.a.work);
  if (!best) return undefined;
  const leftover = query.split(/\s+/).filter((w) => {
    const t = tokens(w);
    return t.length > 0 && !t.every((x) => best.a.workWords.has(x));
  });
  return { best, leftover };
}

/**
 * A narrower second query once the first round has identified the work: its title plus the query words
 * that are not part of it. "CamelPhat Elderbrook Cola ZHU Remix" -> "Cola ZHU Remix", which Spotify finds
 * even though its credit for that remix leaves Elderbrook out.
 */
function refinedQuery(query: string, work: ReturnType<typeof identifiedWork>): string | undefined {
  if (!work?.leftover.length) return undefined;
  const refined = `${work.best.hit.baseTitle} ${work.leftover.join(' ')}`;
  return fold(refined) === fold(query) ? undefined : refined;
}

/** Providers consulted only when the first round has no full answer (rate-limited, or catalog-only). */
const SECOND_ROUND_ONLY = new Set<SearchResult['provider']>(['itunes', 'musicbrainz']);

/** Providers asked on every query; when all of them fail the search has effectively failed. */
export const firstRoundProviders = (providers: SearchProvider[]) => providers.filter((p) => !SECOND_ROUND_ONLY.has(p.name));

export async function mergedSearch(
  query: string,
  opts: { providers?: SearchProvider[]; timeoutMs?: number } = {}
): Promise<MergedSearchResponse> {
  const providers = (opts.providers ?? defaultProviders()).filter((p) => p.configured());
  const degraded = new Set<SearchResult['provider']>();
  const q = parseQuery(query);

  const ask = async (calls: Array<[SearchProvider, string]>): Promise<Member[]> => {
    const answers = await Promise.all(
      calls.map(async ([p, text]) => {
        try {
          if (cooldownUntil(p.name)) throw new Error(`${p.name} cooling down after throttling`);
          if (!takeBudget(p.name)) throw new Error(`${p.name} over its request budget`);
          const rs = await withTimeout(
            p.search(providerQuery(p.name, text)),
            opts.timeoutMs ?? PROVIDER_TIMEOUTS[p.name] ?? PROVIDER_TIMEOUT_MS,
            `${p.name} search`
          );
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

  // iTunes (20/min) and MusicBrainz (1/s) are held back for queries the others could not fully answer.
  // With only second-round providers configured (e.g. SEARCH_PROVIDERS=musicbrainz) they answer the plain query.
  const first = firstRoundProviders(providers);
  const primary = first.length ? first : providers;
  const itunes = first.length ? providers.filter((p) => p.name === 'itunes') : [];
  const musicbrainz = first.length ? providers.filter((p) => p.name === 'musicbrainz') : [];

  let members = await ask(primary.map((p) => [p, query]));
  let ranked = rank(members, q);
  if (!ranked.some((r) => r.a.strong)) {
    // a provider that already failed or hung in this request is not asked again (it would cost a second timeout)
    const usable = (ps: SearchProvider[]) => ps.filter((p) => !degraded.has(p.name));
    const work = identifiedWork(query, ranked);
    const refined = refinedQuery(query, work);
    const calls: Array<[SearchProvider, string]> = itunes.map((p) => [p, query]);
    if (refined) calls.push(...usable(primary).map((p): [SearchProvider, string] => [p, refined]));
    // MusicBrainz lists every recording of a work, including versions the streaming catalogs lack. Without an
    // identified work (e.g. a half-typed query) it would only queue behind its 1 req/s limit for nothing.
    if (work) {
      const mbq = musicbrainzWorkQuery(work.best.hit.baseTitle, work.best.lead, work.leftover);
      calls.push(...musicbrainz.map((p): [SearchProvider, string] => [p, mbq]));
    }
    if (calls.length) {
      members = members.concat(await ask(calls));
      ranked = rank(members, q);
    }
  }

  return {
    hits: uniqueKeys(groupByWork(ranked.map((r) => r.hit))),
    degraded: providers.map((p) => p.name).filter((n) => degraded.has(n)),
  };
}
