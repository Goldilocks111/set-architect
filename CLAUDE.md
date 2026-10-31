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
