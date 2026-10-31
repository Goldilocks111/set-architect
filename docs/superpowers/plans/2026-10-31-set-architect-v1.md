# Set Architect V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-page DJ set builder with live energy curve and explainable next-track suggestions (Camelot + BPM + energy arc + real-set co-occurrence + similarity), plus Supabase/Stripe SaaS plumbing that activates when keys are supplied.

**Architecture:** Next.js App Router monorepo. Pure-TS suggestion engine (`src/engine`, zero I/O, unit-tested against the rulebook). Multi-source metadata resolver behind one adapter interface (`src/lib/sources`). Local polite scraper CLI builds a 1001Tracklists adjacency index. Demo mode (seed JSON, no keys) is first-class; Supabase/Stripe light up via env.

**Tech Stack:** Next.js 15/16 + TypeScript + Tailwind + Recharts + Vitest; @supabase/ssr + supabase-js; stripe; cheerio (scraper parsing); tsx (CLI).

**Spec:** `docs/specs/2026-10-31-dj-playlist-design.md` (+ normative rulebook `docs/research/mixing-rulebook.md`, source verdicts in `docs/research/`).

## Global Constraints

- Node 20+, TypeScript strict. Vitest for all unit tests; `npm test` must stay green at every commit.
- No Spotify API calls anywhere. No hidden/audio-only YouTube players. iTunes previews must render the "Download on iTunes" badge link + "provided courtesy of iTunes" attribution near the player.
- GetSongBPM adapter requires a visible backlink to getsongbpm.com in the app footer (render whenever that adapter is configured).
- Scraper: ≥2s jittered delay between requests, disk cache under `data/cache/` (gitignored), never fetch `/track/...` pages, persist `guid` cookie, custom UA string `SetArchitect/0.1 (personal research tool)`.
- All secrets via env; `.env.example` lists names only. Missing key ⇒ adapter reports `configured(): false`, never throws at import time.
- Camelot scores, BPM windows (±3% soft / ±6% hard), energy rules (|ΔE|≤1, +2 only with key energy-boost, one post-peak reset) and composite weights (key .30 / bpm .20 / energy .20 / co-occurrence .20 / similarity .10) exactly as in `docs/research/mixing-rulebook.md`.
- Directory ownership (parallel agents MUST NOT touch dirs they don't own — integrator resolves anything cross-cutting):
  - T1 → `src/engine/**`, `tests/engine/**`
  - T2 → `src/lib/sources/**`, `src/lib/resolver.ts`, `tests/sources/**`
  - T3 → `scripts/scraper/**`, `src/lib/adjacency/**`, `tests/scraper/**`, `data/seed/adjacency.demo.json`
  - T4 → `supabase/**`, `src/lib/supabase/**`, `src/lib/billing/**`, `src/app/(auth)/**`, `src/app/admin/**`, `src/app/api/stripe/**`, `src/app/api/admin/**`, `src/proxy.ts`/middleware
  - T5 → `src/app/(builder)/**`, `src/components/**`, `src/app/api/search/**`, `src/app/api/suggest/**`, `src/app/api/playlists/**`
  - Shared, frozen in Wave 0 scaffold (change only via integrator): `src/types/**`, `src/engine/index.ts` stub signatures, `data/seed/tracks.demo.json`, `src/lib/demo.ts`.

## Review Focus

1. Track with missing bpm/camelot/energy added to a set → curve and suggestions must degrade gracefully (skip unknown dimensions, say "key unknown"), never NaN/crash. → test in T1 (`suggestNext` with partial tracks) and T5 (render with undefined fields).
2. Camelot wrap-around 12↔1 and ring-switch scoring (12A→1A = 0.9; 12B→12A = 0.85) → explicit tests in T1.
3. Half/double-time BPM (86 vs 172 must match at ~0.9×, 128 vs 150 must score 0) → tests in T1.
4. Resolver when every adapter is unconfigured or a fetch rejects/timeouts → returns best-effort Track with `sources` provenance, never throws → tests in T2 (all-mocked failure matrix).
5. Stripe webhook with invalid signature or replayed event → 400 / idempotent no-op; user tier never upgraded without verified signature → tests in T4.
6. Scraper on changed/empty HTML (selector miss) → structured parse error + cached page kept, exit code ≠ 0, no partial garbage rows → fixture test in T3.

---

## Wave 0 — Scaffold (integrator, done before agents launch)

### Task 0: Repo scaffold + frozen contracts

**Files:** Create Next.js app (TS, Tailwind, App Router, src dir, no import alias changes), add `vitest.config.ts`, `src/types/track.ts`, `src/engine/index.ts` (stub implementations, exact signatures below), `src/lib/demo.ts` (loads seed JSON), `data/seed/tracks.demo.json` (~60 house/techno tracks: artist, title, bpm, camelot, energy 1-10, year), `.env.example`, update `CLAUDE.md`.

**Produces (frozen contracts — all later tasks consume these):**

```ts
// src/types/track.ts
export interface Track {
  id: string; artist: string; title: string; remix?: string;
  bpm?: number; camelot?: string; energy?: number;          // energy 1..10
  danceability?: number; popularity?: number;               // 0..1 / 0..100
  isrc?: string; previewUrl?: string; itunesUrl?: string;
  artworkUrl?: string; youtubeUrl?: string; year?: number;
  sources: Record<string, string>;                          // field -> source name
}
export interface SuggestionReason { kind: 'key'|'bpm'|'energy'|'cooccurrence'|'similarity'; label: string; score: number }
export interface Suggestion { track: Track; score: number; reasons: SuggestionReason[] }
export type ArcTemplate = '60min' | '120min';
export interface Weights { key: number; bpm: number; energy: number; cooccurrence: number; similarity: number }
export interface AdjacencyLookup { getNeighbors(trackKey: string): Promise<Array<{ trackKey: string; count: number; direction: 'before'|'after' }>> }
export interface SimilarityLookup { getSimilar(artist: string, title: string): Promise<Array<{ artist: string; title: string; match: number }>> }
export const trackKeyOf: (artist: string, title: string) => string; // normalized "artist|title" join key

// src/engine/index.ts
export function scoreKeyTransition(from: string, to: string): { score: number; label: string };
export function scoreBpmTransition(from: number, to: number): { score: number; relation: 'direct'|'half-time'|'double-time'|'clash' };
export function energyTargetAt(template: ArcTemplate, position: number, totalPlanned: number): number; // 1..10
export function scoreEnergyTransition(fromE: number|undefined, toE: number|undefined, target: number): { score: number; label: string };
export function suggestNext(args: {
  playlist: Track[]; candidates: Track[]; template: ArcTemplate; plannedLength: number;
  weights?: Weights; adjacency?: Map<string, number>; similarity?: Map<string, number>;
}): Suggestion[];                                            // sorted desc, reasons populated
export const DEFAULT_WEIGHTS: Weights;
```

- [x] Scaffold app, configs, types, stubs, seed, commit. (Integrator does this inline.)

---

## Wave 1 — Parallel build (4–5 subagents, each follows TDD: failing test → implement → pass → commit per unit)

### Task 1: Suggestion engine (`src/engine/`)

**Files:** Create `src/engine/camelot.ts`, `bpm.ts`, `energy.ts`, `suggest.ts`; rewrite stub `src/engine/index.ts` to re-export. Tests `tests/engine/*.test.ts`.
**Interfaces:** Consumes frozen types; Produces the exact `src/engine/index.ts` signatures above (unchanged).

- [ ] camelot.test.ts: parse/validate keys; scores: same=1.0; ±1 same letter=0.9 incl. 12A→1A and 1B→12B; ring switch=0.85; +2=0.6 label "Energy boost"; 8A→9B=0.3; 8A→5A=0.2; 8A→3A=0.15; incompatible=0; invalid key → score 0 label "Key unknown". Implement, pass, commit.
- [ ] bpm.test.ts: 128→128=1.0 direct; 128→131.8 (+3%) ≈ linear mid; 128→135.7 (+6%)=0; beyond=clash score 0; 86→172 matches as double-time at 0.9×direct-equivalent; 174→87 half-time. Implement (linear falloff to 0 at 6%), pass, commit.
- [ ] energy.test.ts: `energyTargetAt('60min', p, 15)` follows rulebook template (T1-3→4–5, …, peak T12-13→8–9, cooldown); 120min template with reset + second peak; `scoreEnergyTransition`: ΔE 0/±1 near target=1.0; +2=0.4 label "Big energy jump"; toE undefined → 0.5 label "Energy unknown"; moving away from target penalized. Implement, pass, commit.
- [ ] suggest.test.ts: composite weighting with DEFAULT_WEIGHTS; hard filter: keyScore<0.3 AND bpmScore<0.3 excluded; candidates already in playlist excluded; partial-data tracks (no bpm or no camelot) still rank with reasons marked unknown (Review Focus 1); adjacency map boosts and yields reason "Played after X in N real sets"; empty playlist → ranks by arc-start fit (energy ≈ template start). ΔE=+2 allowed only when key transition is the +2 energy boost. Implement, pass, commit.

### Task 2: Metadata adapters + resolver (`src/lib/sources/`, `src/lib/resolver.ts`)

**Files:** Create `src/lib/sources/types.ts` (adapter interface below), `deezer.ts`, `itunes.ts`, `getsongbpm.ts`, `soundstat.ts`, `reccobeats.ts`, `lastfm.ts`, `listenbrainz.ts`, `youtube.ts`; `src/lib/resolver.ts`; `src/lib/http.ts` (fetch with timeout+retry). Tests `tests/sources/*.test.ts` with mocked `fetch` (never hit network in tests).

**Interfaces:** Produces:
```ts
export interface SourceAdapter {
  name: string;
  configured(): boolean;                       // env-based; keyless adapters → true
  enrich(partial: Track): Promise<Partial<Track>>; // only fields this source knows; throws → resolver catches
}
export function resolveTrack(artist: string, title: string): Promise<Track>;  // order: deezer→itunes→getsongbpm→soundstat→reccobeats; merges with provenance; 4s/adapter timeout
export function searchTracks(query: string): Promise<Track[]>;                // deezer search primary, itunes fallback, demo seed when offline/unconfigured
export function getSimilarTracks(artist: string, title: string): Promise<Array<{artist: string; title: string; match: number}>>; // lastfm → listenbrainz fallback
export function adapterHealth(): Array<{ name: string; configured: boolean }>;
```
Key facts per adapter from `docs/research/audio-features-sources.md` (endpoints, Deezer bpm=0 caveat — never map it, map `rank`→popularity + `preview`; iTunes previewUrl + itunesUrl; GetSongBPM base `api.getsong.co`; pitch-class→Camelot 24-entry table lives here as `toCamelot(key:number, mode:number)`).
Env names: `GETSONGBPM_API_KEY`, `SOUNDSTAT_API_KEY`, `LASTFM_API_KEY`, `YOUTUBE_API_KEY` (optional; else construct `youtube.com/results?search_query=` URL).

- [ ] Per adapter: failing test (mocked happy path + error path) → implement → pass → commit (one commit per adapter is fine).
- [ ] resolver.test.ts: merge precedence + provenance; all-adapters-fail → returns Track with just artist/title/id (Review Focus 4); timeout respected (fake timers). Implement, pass, commit.

### Task 3: 1001Tracklists scraper + adjacency index (`scripts/scraper/`, `src/lib/adjacency/`)

**Files:** Create `scripts/scraper/cli.ts` (run via `npm run scrape -- <subcommand>`), `scripts/scraper/fetchPage.ts` (politeness: 2–4s jitter, disk cache `data/cache/1001tl/`, guid cookie jar `data/cache/cookies.json`, UA per Global Constraints), `scripts/scraper/parseTracklist.ts`, `scripts/scraper/parseSearch.ts`, `src/lib/adjacency/index.ts`, `src/lib/adjacency/store.ts` (JSON file store `data/index/adjacency.json`; interface designed so Supabase store can replace it). Tests `tests/scraper/*.test.ts` against HTML fixtures `tests/scraper/fixtures/` (agent fetches ONE real tracklist page + ONE search response manually to create fixtures; all tests offline).

**Interfaces:** Consumes `trackKeyOf`. Produces:
```ts
// cli subcommands
// npm run scrape -- search "artist or event"     → lists tracklist URLs
// npm run scrape -- tracklist <url> [...urls]    → parse + upsert into index
// npm run scrape -- crawl "<query>" --max 20     → search + fetch top N tracklists
// npm run scrape -- stats                        → index summary
export function loadAdjacency(): Promise<AdjacencyLookup & { pairCount: number; trackCount: number }>;
export function buildDemoAdjacency(): void; // generates data/seed/adjacency.demo.json from seed tracks (plausible fake adjacency) — used in demo mode
```
Selectors + POST search mechanics exactly per `docs/research/1001tracklists-access.md` (`div.tlpTog`, `.trackValue`, `.fontXL`, POST `/search/result.php` `main_search`/`search_selection=9`). Never fetch `/track/...` URLs.

- [ ] parseTracklist fixture test: extracts ordered `{position, artist, title, remix?}`; selector miss on mangled fixture → throws `ParseError` naming the selector (Review Focus 6). Implement, pass, commit.
- [ ] parseSearch fixture test → implement → commit.
- [ ] adjacency store test: ingest two tracklists sharing tracks → neighbor counts/direction correct; idempotent re-ingest (same tracklist id doesn't double-count). Implement, pass, commit.
- [ ] fetchPage test (mocked fs/fetch): cache hit skips network; delay enforced between live calls. Implement; wire CLI; `npm run scrape -- stats` works on empty index; generate `adjacency.demo.json`; commit.
- [ ] Live smoke (allowed, polite): crawl ONE known tracklist URL end-to-end, verify rows land in index, commit fixtures only (cache stays gitignored).

### Task 4: Supabase + Stripe + auth + admin plumbing

**Files:** Create `supabase/migrations/0001_init.sql` (tables: profiles, playlists, playlist_tracks, tracks, track_features, tracklists, tracklist_entries, adjacency, subscriptions, usage_events; RLS: owner-only on playlists/usage, admin role via `profiles.is_admin`), `src/lib/supabase/{client,server,admin}.ts` (@supabase/ssr pattern — copy from `../Market research project/webapp`), `src/lib/billing/stripe.ts`, `src/app/api/stripe/checkout/route.ts`, `src/app/api/stripe/webhook/route.ts`, `src/app/api/stripe/portal/route.ts`, `src/app/(auth)/login/page.tsx` (magic link), onboarding `src/app/(auth)/welcome/page.tsx`, `src/app/admin/page.tsx` (users table, plan, usage, adapter health via `adapterHealth()` from T2 contract), middleware for auth-gating `/admin` + `/app`. Tests `tests/billing/*.test.ts`.
**Env names:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `NEXT_PUBLIC_APP_URL`.
**Demo mode rule (critical):** `isDemoMode()` in `src/lib/supabase/client.ts` = true when Supabase env missing → auth pages show "demo mode" and app runs without login; all server code branches through it. The app MUST build and run with an empty `.env`.

- [ ] Migration SQL + a schema test is impractical offline → instead: `supabase/README.md` with exact `npx supabase db push` steps; typecheck-level test that table row types (`src/lib/supabase/types.ts`, hand-written) compile against queries. Commit.
- [ ] webhook.test.ts (stripe lib's constructEvent mocked): bad signature → 400; `checkout.session.completed` → subscription row upsert; replay (same event id) → no-op (Review Focus 5). Implement routes, pass, commit.
- [ ] Auth pages + middleware + onboarding + admin page render in demo mode without env (component smoke tests). Implement, pass, commit.
- [ ] Free-tier gate: `src/lib/billing/entitlements.ts` → `canCreatePlaylist(userId)`, `canSuggest(userId)` (free: 1 playlist, 20 suggestions/day; pro/demo: unlimited) + unit test. Commit.

### Task 5: Builder UI + app API routes

**Files:** Create `src/app/(builder)/page.tsx` (THE page), components `src/components/{SearchBar,SetList,SetRow,TransitionBadge,EnergyCurve,SuggestionBox,SuggestionCard,PreviewPlayer,DemoBanner,ArcTemplatePicker}.tsx`, API routes `src/app/api/search/route.ts` (→ `searchTracks`), `src/app/api/suggest/route.ts` (→ assembles candidates: adjacency neighbors + similar tracks + demo pool, resolves metadata, calls `suggestNext`), `src/app/api/playlists/route.ts` (CRUD; Supabase when configured else localStorage client-side). Tests: `tests/ui/*.test.tsx` (vitest + @testing-library/react) for EnergyCurve data mapping, SuggestionCard reasons rendering, reducer for playlist state.
**Interfaces:** Consumes ONLY the frozen contracts (engine stubs ok — real engine lands from T1 at integration) + T2/T3 function signatures above.
**UX decisions (locked):** energy curve = Recharts ComposedChart: actual energy line + target-arc dashed line + BPM bars on secondary axis; transition badge between rows shows key/bpm/energy glyphs colored by score; suggestion card shows score, reason chips, iTunes preview `<audio>` with badge+attribution, YouTube link-out button; demo banner when `isDemoMode()`; GetSongBPM footer backlink when configured; keyboard: Enter adds top search hit.

- [ ] Playlist state reducer (add/remove/reorder/clear) test → implement → commit.
- [ ] EnergyCurve mapping test (playlist → chart series incl. undefined-energy gaps, target arc series from `energyTargetAt`) → implement → commit.
- [ ] API routes: suggest route test with demo data (returns ≤10 suggestions with reasons) → implement → commit.
- [ ] Page assembly + components; `npm run build` passes; demo-mode screenshot via dev server. Commit.

---

## Wave 2 — Integration & verification (integrator + 1 reviewer agent)

### Task 6: Integration

- [ ] Swap engine stubs → real engine; wire suggest route to real adjacency index (falls back to demo adjacency); full `npm test` + `npm run build` green; fix seams.
- [ ] End-to-end demo-mode walkthrough with Playwright MCP: search → add 5 tracks → curve updates → suggestions show reasons → preview plays. Screenshot into `docs/verification/`.
- [ ] `/code-review` on the whole branch; triage + fix findings.
- [ ] README.md: what it is, demo-mode quickstart (`npm i && npm run dev`), key activation table (which feature each key unlocks), scraper usage + etiquette, architecture map.
- [ ] Update CLAUDE.md log; final commit. Deliver handover summary with exact list of keys needed.

## Keys the owner must supply (final handover will restate)
Required for SaaS mode: Supabase URL/anon/service-role, Stripe secret/webhook/price id.
Recommended free: GETSONGBPM_API_KEY, LASTFM_API_KEY. Optional paid: SOUNDSTAT_API_KEY (~$15/mo or $0.01/track). Already owned: YOUTUBE_API_KEY (reuse from market-research `.env`).
