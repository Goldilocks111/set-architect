# Set Architect — DJ playlist builder: V1 design

Date: 2026-10-31 · Owner: the project owner · Author: Claude (project manager). Research basis: docs/research/*.

## Intent & why
DJs (the owner included) struggle to pick tracks that *transition well* in a 1–2 hour set. The
information exists — key, BPM, energy, and what famous DJs actually played back-to-back — but no
tool combines it in one live workspace. V1 is a working POC: a one-page set builder with live
energy visualization and explainable next-track suggestions, plus the SaaS plumbing (auth,
billing, admin) wired and ready for keys.

## Goals (V1)
1. Build a playlist on one page; every added track updates a **live energy curve** (with BPM
   overlay) against a target arc template (60/120-min presets).
2. A **suggestion box** ranks candidate next tracks with human-readable reasons
   ("8A→9A smooth · +2 BPM · energy +1 · followed this track in 3 real sets").
3. Suggestions scored per docs/research/mixing-rulebook.md: Camelot, BPM ±3% (half-time aware),
   energy arc fit, 1001Tracklists co-occurrence, Last.fm similarity.
4. Track search + metadata resolution via the multi-source resolver
   (docs/research/audio-features-sources.md) with per-track preview (iTunes 30s audio; YouTube
   link-out) — Chosic-style UX.
5. 1001Tracklists ingestion: a local, rate-limited scraper CLI that builds a track-adjacency index
   (runs on the owner's machine/residential IP; cached; tracklist pages only — never captcha-gated
   track pages).
6. SaaS plumbing that lights up when keys are pasted: Supabase auth (email magic link) + Postgres,
   Stripe subscription checkout + webhook, onboarding flow, basic admin dashboard (users, plans,
   data-source health). Everything behind adapters + `.env.example`.
7. Works with **zero keys** out of the box: seeded demo dataset (~60 house/techno tracks with
   BPM/key/energy) + mock co-occurrence data, demo mode clearly labeled.

## Non-goals (V1)
- No audio analysis of local files (Essentia/MIK import is V2; schema leaves room).
- No auto-mixing/audio playback of transitions; previews only.
- No mobile app; responsive web only.
- No social features, sharing, or export to Rekordbox/Spotify (V2 candidates).
- No high-volume cloud scraping; ingestion is local and polite by design.

## Anti-goals
- Building on Spotify's API in any form (dead for new apps).
- Hidden/background YouTube audio players (ToS violation).
- Shipping suggestions without reasons — a black-box "trust me" list is the failure mode of
  existing tools.

## Architecture (decided)
- **Next.js (App Router) + TypeScript + Tailwind + Recharts**, Vitest for tests — mirrors
  energy-platform conventions.
- **Supabase** (Postgres + auth) via `@supabase/ssr`; schema in `supabase/migrations/*.sql`.
  Local dev without keys falls back to demo mode (in-memory/seed JSON).
- **Stripe**: one "Pro" subscription product; checkout session + customer portal + webhook route;
  free tier = 1 playlist, 20 suggestions/day (enforced server-side, generous in demo mode).
- **Suggestion engine**: pure TypeScript module (`src/engine/`), zero I/O, fully unit-tested
  against the rulebook — the heart of the product.
- **Data adapters** (`src/lib/sources/`): deezer, itunes, getsongbpm, soundstat, reccobeats,
  lastfm, listenbrainz, youtube — one interface, per-adapter "unconfigured/healthy/error" status
  surfaced in admin.
- **Scraper CLI** (`scripts/scraper/`): Node CLI, polite (1 req/2–4s jittered, disk cache,
  guid cookie), parses tracklist pages with selectors documented in research; writes to Supabase
  (or local SQLite JSON fallback in demo mode) → `tracks`, `tracklists`, `adjacency` tables.
- **DB core tables**: users/profiles, playlists, playlist_tracks, tracks (canonical, keyed by
  internal id + ISRC/MBID when known), track_features (per-source provenance), tracklists,
  tracklist_entries, adjacency (track_a, track_b, count, sources), subscriptions, usage_events.

## UX (one page, Chosic-inspired)
Left/main: search bar → add tracks; ordered set list showing per-track Camelot badge, BPM, energy
chip, transition-quality indicator between rows. Top: live Recharts energy curve (actual vs target
arc, draggable template select 60/120 min). Bottom/right: suggestion box (top ~10, each with
score reasons, preview play button, YouTube link, "+ add"). iTunes badge + attribution near
previews. Demo-mode banner when no keys.

## The parts left to the builder
Component layout details, exact copy, loading states, and admin table design — follow
energy-platform visual conventions (Tailwind, hand-rolled components, Recharts).

## Calls made by Claude (flag if wrong)
- Product name placeholder: **"Set Architect"** (rename anytime).
- Supabase chosen over Prisma+pg (energy-platform pattern) because auth+db+admin come in one
  service and the market-research webapp already shows the wiring.
- Suggestion weights default per rulebook §4; tunable via UI sliders later.
- Last.fm key is dev/non-commercial tier for POC; ListenBrainz adapter included as the
  commercial-safe fallback.
