# DJ Music Playlist — project notes for Claude

## What this is
A playlist-builder for DJs: one-page app where you add tracks to a set, see a **live energy curve**
(Recharts), and get **next-track suggestions** scored by Camelot key compatibility, BPM delta,
energy-arc fit, co-occurrence in real DJ sets (1001Tracklists adjacency index), and similarity
(Last.fm/ListenBrainz). Chosic-style UX with iTunes 30s previews + YouTube link-out/embed cards.

Owner: a working DJ — this scratches their own itch. Claude is project manager; builds run
through subagents working off `docs/specs/build-plan.md`.

## Key decisions (research-backed — see docs/research/)
- **Spotify API is unusable** for new apps (audio features / recommendations / previews all blocked
  since Nov 2024). Never plan features on it.
- **1001Tracklists**: no API. Scrape TRACKLIST pages only (SSR, no Cloudflare); per-track pages are
  captcha-gated — build our own local adjacency index instead. Residential IP, slow + cached.
  Selectors documented in docs/research/1001tracklists-access.md.
- **Suggestion engine rules** are normatively specified in docs/research/mixing-rulebook.md
  (Camelot transition scores, BPM ±3%/±6% with half-time equivalence, energy |ΔE|≤1 + arc templates,
  composite weights). Engine is built test-first against that file.
- **Previews**: iTunes Search API (keyless; requires iTunes badge + attribution, stream-only).
  YouTube embeds must be VISIBLE players (no hidden audio-only — ToS).
- **Stack**: Next.js + TypeScript + Tailwind + Recharts + Supabase (auth/db) + Stripe (billing
  plumbing), patterns lifted from `../energy-platform` (charts, vitest) and
  `../Market research project/webapp` (Supabase+Stripe wiring).

## Conventions
- Log every connection/feature/fix/lesson here, same turn as the work (the owner's standing rule).
- All third-party keys live in `.env` (gitignored); `.env.example` lists names only.
- Subagents write progress back to docs/specs/build-plan.md (checkboxes + notes per task).

## Provider quotas (hard-won — 2026-11-01)
- Spotify dev-mode app: heavy benchmark traffic (~500 search calls in a few hours across agents)
  triggered a 429 with Retry-After ≈ 13.8h — the WHOLE app (incl. Spotify Connect) is locked out.
- iTunes Search API: ~20 req/min; bursts above that → IP-level 403 lasting hours.
- Rules: one agent owns each provider's live traffic at a time; benchmarks run with per-provider
  request budgets; the merger has a circuit breaker honoring Retry-After; search results cached 24h.

## Log
- 2026-10-31: Project kicked off. 4 research agents ran (1001TL access, audio-feature APIs,
  mixing theory + similarity/previews, asset inventory). Verdicts in docs/research/. Git repo
  initialized on `main`.
- 2026-10-31: V1 built on branch `v1-build` via subagent-driven development (5 parallel
  implementers + per-task reviews + fix rounds; ledger in .superpowers/sdd/). 230+ tests, build
  green. Lessons:
  - Next 16 + cacheComponents rejects `export const runtime='nodejs'` in route handlers.
  - vitest 5 needs @types/node ≥22 (scaffold pins ^20 — bump it).
  - Deezer fielded search (`artist:"x" track:"y"`) returns 0 live; plain query + artist match works.
  - SoundStat/ReccoBeats key off SPOTIFY track ids (no name search) — dormant until an id mapping
    source (ListenBrainz labs) is wired. GetSongBPM needs visible backlink (footer renders it).
  - 1001TL scraper: guard must normalize+manual-redirect, abort crawl on 401/403/429.
  - Agents committed as user@host.local before repo-local git identity was set — authors rewritten
    to noreply before any push (never push without checking `git log --format='%ae'`).
- 2026-10-31: Found working 1001TL AJAX track-search endpoint (JSON, no captcha, returns
  play_count = sets-played-in + canonical ids) via read-only review of
  conrad-scherb/1001-tracklists-scraper — details in docs/research/1001tracklists-access.md.
  V1.1 scraper upgrade path: data-trackid adjacency keys + play_count enrichment.
- 2026-10-31: .env created (gitignored); YOUTUBE_API_KEY copied over from market-research project.
- 2026-10-31: Spotify adapter added (client-credentials, catalog search ONLY → spotifyId +
  spotifyUrl link-out; deprecated endpoints never called). Sits between itunes and getsongbpm in
  the resolver so ReccoBeats/SoundStat receive spotifyId in the same pass → free energy/
  danceability via ReccoBeats once SPOTIFY_CLIENT_ID/SECRET are set. "Suggestions don't change"
  user report root-caused: not a bug — added tracks lacked key/bpm/energy data; fixed by data
  wiring (GetSongBPM key + Spotify→ReccoBeats), engine/UI verified correct.
- 2026-10-31: "Page keeps flickering" bug: Playwright MCP writes logs into ./.playwright-mcp at
  runtime; Turbopack watched it -> infinite rebuild/Fast Refresh loop. Fixed with
  next.config watchOptions.ignored (also ignores data/cache + data/index). Lesson: never let
  runtime artifacts land in watched folders.
- 2026-10-31 (V1.2): Spotify Connect (OAuth, playlist import, save-set-to-Spotify; security
  review approved after hardening: fixed redirect_uri env override, api.spotify.com-only bearer,
  playlist-id validation). Keyless BPM/key/energy via MusicBrainz→AcousticBrainz (API still live!)
  + Deezer-preview tempo analysis (music-tempo + mpg123-decoder). Live per-track 1001TL ingestion
  queue (one job at a time; HTTP 206 = soft-block → 60-min queue pause, gentler resume; index
  grows over days). ALL runtime data moved to ~/.setarchitect (Turbopack has no watch-ignore —
  runtime writes in repo cause rebuild loops). 304 tests green.
- 2026-11-01 (V2 Phase 2 — search): merged multi-provider search (Spotify+Deezer stage 1;
  MusicBrainz + refined queries stage 2; iTunes optional behind breaker), version parser +
  version chips, ISRC/signature dedup, persistent circuit breaker + 24h cache. ACCEPTANCE RUN
  (single, after Spotify lockout cleared): track hit-rate 98% raw / 97% audited (classic 98%,
  recent 96%), version-correctness 93.3%, total p95 1240ms (stage-1 747ms) — all targets met;
  R13 progressive results not needed. Baseline: docs/research/search-bench-baseline-2026-11-01-merged.json,
  memo docs/research/search-coverage-bench.md. Lessons: the auditor caught a false pass
  (Guetta/Benassi rework accepted by the artist-credit subset rule) — always hand-audit
  "+extras" hits; a Spotify-degraded run silently looked like a valid one — benchmarks must
  fail PARTIAL when any required provider degrades; one probe before any bench after a lockout.
- 2026-11-01: Fix "two children with the same key" console error in the Spotify import picker:
  Spotify's /me/playlists repeats a playlist across pages, and a playlist can hold the same
  track twice → duplicate React keys. listPlaylists/playlistTracks now dedupe by id (first wins).
  Lesson: never assume provider pagination yields unique ids.
- 2026-11-01: Last.fm key setup. Incident: a "masked" grep of .env used `\s` in BSD sed (macOS
  doesn't support it) → the value of a line with `= value` printed in clear into the session;
  key + shared secret rotated. RULE: never grep/print .env lines, even "masked" — check secrets
  only via `node --env-file=.env` printing presence/length. Also: the app reads
  LASTFM_API_KEY (not LASTFM_API); shared secret is not needed.
- 2026-11-02 (V2 Phase 1 — essential data): plan docs/superpowers/plans/2026-11-02-v2-phase1-data.md,
  built on branch v2-phase1 via parallel subagents in manual worktrees (../setarch-wt/*; the
  Agent tool's isolation:worktree fails here because the harness resolves git from $HOME).
  Shipped: in-house preview analysis (FFT/chroma key with Temperley profile, fitted energy/
  danceability; no essentia.js — AGPL); completeness gate (complete | incomplete(reason)) +
  persistent metadata cache (~/.setarchitect/index/metadata.json, negative cache, re-resolve
  queue); engine excludes incomplete tracks; badges/quarantine/60 s resolving clock; manual
  override editor + guarded override route (JSON + same-origin; user required outside demo);
  Mixed In Key CSV import; missing danceability falls back to an 'estimate-prior' from energy;
  1001TL background driver (`npm run ingest:live`, lock + growth.jsonl, 7-day halt after 3 hard
  blocks); search follow-ups (stricter R15b scorer, MB discovery query). 895 tests.
  U2 result (docs/research/data-yield-bench.md): providers alone complete 48% (recent 2%); with
  local analysis 89% (recent 78%). Local key vs ReccoBeats held-out 56% exact+relative (target
  60% missed) → SoundStat-for-key pending owner OK. Deezer terms: preview analysis OK for
  personal non-commercial use only — a paid product needs Deezer's written approval.
  Lessons:
  - Accuracy benches must exclude values the pipeline itself produced (first U2 run compared
    local analysis with itself). Report nested/held-out numbers; select features inside folds.
  - The Mac sleeps: setTimeout pauses during sleep, so long-running drivers must sleep in short
    wall-clock-checked chunks (driver sat 12 h in a "60 min" pause). Agents also die mid-reply
    on sleep — run `caffeinate -i -s` for long sessions.
  - Turbopack served a stale imported JSON (demo seed) after a merge → empty suggestions until
    the dev server was restarted. Restart `npm run dev` after merges that change imported data.
  - Benchmarks running in a temp data dir must still read/merge the REAL provider-cooldowns file,
    and any provider in cooldown at start/end makes the run PARTIAL.
  - Never exercise the override editor / MIK import against the real cache in browser checks:
    manual values are permanent and beat every provider.
- 2026-11-02 (V2 Phase 3 — recommendations): plan docs/superpowers/plans/2026-11-02-v2-phase3-recs.md,
  branch v2-phase3. Shipped: client crate (localStorage, ≤ 2000, ≤ 600 sent) as the primary pool,
  server lazily fills ≤ 2 crate items per refresh (Spotify/Deezer only), `crateKnown` sync, demo
  "starter crate" below 30 ready tracks; Last.fm tags → 20 DJ lanes (`styles`, background queue,
  breaker/budget 120/min, ≤ 4 req/s); engine lane fit + similar tracks from the last 3 tracks
  (24 h cache) + compliance-first ranking (criterion 3); radio mode; `npm run bench:recs`
  (`--warm` resumable warm-up; shared ~225-track library crate; compliantAvailable / pool-limited)
  and a blind A/B rating page at /rate (dev only) scored by `npm run bench:recs:ratings`.
  Automatic background resolves skip YouTube (shared Data API key with market-research).
  Lessons:
  - Track lists written from model memory were ~25% fictional or mis-credited; bench fixtures
    must be grounded (verified search list or tracks seen in the 1001TL index, with neighbour
    evidence for lane), and lane labels audited from cached tags after warm-up.
  - Criterion 3 is bounded by pool composition (≥ 8 compliant tracks must exist) — measure
    compliantAvailable separately from engine quality; a blind rating needs a control list
    matched on lane AND tempo, or the engine list is identifiable by genre.
  - Parallel worktrees can auto-merge into a semantic break (an options type lost a field) —
    always run tsc after every merge, not just tests.
  - A test asserting random ciphertext lacks a 2-letter string fails ~4% of runs — flaky tests
    can be real test bugs, not load.
- 2026-11-02 (Phase 3 Task 8): blind A/B rating made fair (lane+tempo-matched baseline, one naming
  rule per scenario, unique run ids); engine caps 2 tracks per primary artist in the top 10.
  DATA BUG found + fixed: Deezer/Spotify enrichment matched on artist only, so a missing track could
  take another song's preview/Spotify id (→ wrong BPM/key/energy). New recording matcher
  `src/lib/sources/match.ts` (parseVersion-based: base title + version kind + remixer; edits/extended/
  12"/remaster = same recording). Pre-fix caches moved to ~/.setarchitect/backup-2026-11-02-prematchfix;
  U2 accuracy numbers flagged provisional (erratum in docs/research/data-yield-bench.md §6).
  Lesson: "first hit by the right artist" is never a match — always verify title + version.
