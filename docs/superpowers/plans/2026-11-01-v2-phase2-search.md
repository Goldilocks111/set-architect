# V2 Phase 2 — Search to Spotify benchmark: Implementation Plan

> **For agentic workers:** Execute your own task only. Steps use checkbox (`- [ ]`) syntax. Write your
> progress to your report file as you go (status, done, in progress, blockers) — the controller reads it.

**Goal:** Search finds ≥90% of a frozen 100-track benchmark (50 classics / 50 releases from the last
12 months) and correctly distinguishes original/extended/remix/radio versions on ≥90% of 30 version cases.

**Architecture:** Each provider (Spotify, Deezer, iTunes) implements one `SearchProvider` contract
returning normalized `SearchResult`s with a parsed `version`. A merger fans out to all configured
providers in parallel, dedups by ISRC (then by normalized artist|baseTitle|version), ranks, and returns
version-distinct `MergedHit`s. A benchmark harness measures every provider and the merger against
frozen fixtures, so the provider mix is decided by data (Phase 0 / U1), not assumption.

**Tech Stack:** TypeScript, Next.js route handlers, Vitest. No new dependencies.

**Spec:** `docs/specs/2026-11-01-v2-product-plan.md` (Phase 0 U1 + Phase 2 + "working website" criterion 2).

## Global Constraints

- Frozen contract: `src/lib/search/types.ts` — do not change; ask the controller.
- Spotify: client-credentials catalog search ONLY (`GET /v1/search?type=track`). Dev-mode apps are
  capped (limit ≤ 10 per request as of Feb 2026) — respect it; never call deprecated endpoints.
- Unit tests: all network mocked. Live calls only inside the benchmark harness (`npm run bench:search`),
  never in `npm test`.
- Benchmark etiquette: ≤ 3 requests/second total per provider, sequential per provider; Deezer ≤ 50 req/5s.
- No new npm dependencies. No edits outside your owned paths. Never `git add -A`; retry on index.lock.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Acceptance numbers (verbatim): track hit-rate ≥ 90% on `bench/search/tracks.json`;
  version-correctness ≥ 90% on `bench/search/versions.json`; merged search p95 latency < 1.5s.

## Review Focus

1. Remix vs original confusion: "Cola (Extended Mix)" and "Cola (Mark Knight Remix)" must never merge.
2. Featured artists in titles ("feat.", "ft.", "with") must not break matching or dedup.
3. Non-Latin / accented artists ("Ben Böhmer", "Rüfüs Du Sol") must match normalized queries.
4. A provider timing out must degrade the response (`degraded`), not fail it.
5. Same ISRC with different provider titles ("Original Mix" vs plain) must merge into one hit.

---

## Wave 1 (parallel)

### Task 1 (U1): Benchmark fixtures + harness

**Files:** Create `bench/search/tracks.json`, `bench/search/versions.json`, `bench/search/run.ts`,
`bench/search/score.ts`, `tests/search/benchScore.test.ts`; add npm script `bench:search` (`tsx bench/search/run.ts`).
Write U1 decision memo `docs/research/search-coverage-bench.md` after Task 4 is merged (controller will ask).

**Interfaces:** Consumes `SearchProvider`, `SearchResult`, `MergedSearchResponse` from `src/lib/search/types.ts`.
Produces:
```ts
// bench/search/score.ts
export interface BenchTrack { id: string; artist: string; title: string; version?: string; releaseYear: number; bucket: 'classic' | 'recent'; query: string }
export interface BenchVersionCase { id: string; query: string; expect: { artist: string; baseTitle: string; kind: VersionKind; remixer?: string } }
export function isHit(t: BenchTrack, results: Array<{ artist: string; baseTitle?: string; title?: string }>, topN?: number): boolean; // match within top 5 (default)
export function versionCorrect(c: BenchVersionCase, results: Array<{ artist: string; version: ParsedVersion }>): boolean; // top-3 contains the exact expected recording
```
- [ ] Build `tracks.json`: exactly 100 entries, 50 `classic` (released ≤ 2022) and 50 `recent` (released
  Nov 2025 – Oct 2026), house/techno/melodic/afro/tech-house weighted to a working DJ's crate. Source
  recent releases from public charts (e.g. Beatport/1001Tracklists chart pages read via web search) and
  record each entry's source URL in a `source` field. `query` = what a DJ would type ("artist title").
- [ ] Build `versions.json`: exactly 30 cases across original / extended / remix (named remixer) / radio edit.
- [ ] Write failing tests for `isHit` and `versionCorrect` (normalization: case, accents, "feat." stripping, "&"/"and").
- [ ] Implement `score.ts`; tests pass.
- [ ] Implement `run.ts`: for each configured provider AND the merger (if `src/lib/search/merge.ts` exists),
  run all queries sequentially with ≤3 req/s, write `bench/search/results/<date>-<target>.json`, print
  a table: hit-rate overall/classic/recent, version-correctness, p50/p95 latency. Gitignore `bench/search/results/`.
- [ ] Commit.

### Task 2: Version parser

**Files:** Create `src/lib/search/version.ts`, `tests/search/version.test.ts`.
**Produces:** `export function parseVersion(rawTitle: string, artists?: string[]): ParsedVersion;`
- [ ] Failing tests covering at least: "Cola (Original Mix)"→original; "Cola"→original; "Cola (Extended Mix)"→extended label "Extended Mix";
  "Cola - Radio Edit"→radio; "Cola (Mark Knight Remix)"→remix remixer "Mark Knight"; "Opus (Four Tet Remix) [Extended]"→remix + extended label kept;
  "Breathe (feat. Cristoph)"→featuring ["Cristoph"], baseTitle "Breathe"; "Track - 2014 Remaster"→remaster;
  "Track (VIP)"→vip; "Track (Dub Mix)"→dub; "Track - Live at Printworks"→live; "Track (Instrumental)"→instrumental;
  "Track (with X)" and "Track [ft. X]"; "Delilah (pull me out of this)"→original (parentheses that are NOT version words stay in baseTitle).
- [ ] Implement with an explicit keyword table; parentheses/brackets/dash-suffix segments only.
- [ ] Commit.

### Task 3: Provider search adapters

**Files:** Create `src/lib/search/providers/spotify.ts`, `deezer.ts`, `itunes.ts`, `src/lib/search/providers/index.ts`,
`tests/search/providers.test.ts`.
**Consumes:** `parseVersion` from Task 2 — it lands in parallel; import it, and until it exists use a local
stub ONLY in tests via `vi.mock('@/lib/search/version')`. Reuse token/HTTP helpers from `src/lib/sources/spotify.ts`
and `src/lib/http.ts` (import, don't duplicate).
**Produces:** `export const searchProviders: SearchProvider[]` (spotify, deezer, itunes, in that order) and each provider individually.
- [ ] Spotify: `GET /v1/search?type=track&limit=10&q=` → all main artists, isrc (external_ids), duration_ms, album.release_date,
  popularity, artwork (largest image ≤ 640), spotifyId/Url, explicit. `configured()` = client id+secret set.
- [ ] Deezer: `GET /search?q=&limit=25` → isrc requires the track detail call — DO NOT call it per result (cost);
  leave isrc undefined from search; duration (s→ms), rank → popularity normalized (log-scale to 0..100, document), release_date absent → undefined.
- [ ] iTunes: `GET /search?media=music&entity=song&limit=25&term=` → artistName, trackName, trackTimeMillis, releaseDate (date part), previewUrl, artwork (artworkUrl100 → 600x600).
- [ ] Each: mocked happy path + empty + HTTP error tests; `version` populated via `parseVersion(title, artists)`.
- [ ] Commit.

## Wave 2 (after Tasks 1–3 merge)

### Task 4: Merged search + UI + benchmark iteration

**Files:** Create `src/lib/search/merge.ts`, `src/lib/search/index.ts`, `tests/search/merge.test.ts`; modify
`src/app/api/search/route.ts`, `src/lib/resolver.ts` (`searchTracks` delegates to merged search, keeping its
signature and the demo-seed fallback), `src/components/SearchBar.tsx` (version chip + grouping); `src/types/track.ts`
gains `durationMs?: number` and `version?: string` (controller-approved).
**Produces:** `export async function mergedSearch(query: string, opts?: { providers?: SearchProvider[]; timeoutMs?: number }): Promise<MergedSearchResponse>;`
- [ ] Failing tests for Review Focus 1–5 + dedup + ranking (exact artist+title match > popularity > recency) + 1.2s per-provider timeout → degraded.
- [ ] Implement; search route returns hits mapped to Track (version label in `version`, durationMs carried).
- [ ] SearchBar: each result shows a version chip (Extended / Remix by X / Radio) and duration; multiple versions of one work stay adjacent.
- [ ] Run `npm run bench:search`; iterate on ranking/matching until acceptance numbers hold for the merger. Record the final table in the report.
- [ ] Commit.
