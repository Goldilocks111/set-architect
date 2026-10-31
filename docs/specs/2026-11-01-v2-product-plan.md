# Set Architect V2 — phased product plan

Date: 2026-11-01. Input: owner's product brief (4 core requirements). Grounded in the V1 build
and research verdicts in docs/research/. Product requirements are fixed; implementation options
are listed separately and must be evaluated against them, not assumed.

## The intended user experience

A DJ opens one page and builds a set for a real slot ("90 minutes, warm-up till peak").
They search for any commercially available track — including last week's releases — and get
accurate, disambiguated results (original vs extended vs remix). Every track they can add shows
BPM, key, energy and danceability; a track missing any of these is visibly "incomplete" and the
app resolves it in the background or tells the user it can't. As the set grows, a live energy
curve shows the journey against the planned arc and duration, and a "Next up" panel suggests
tracks that are harmonically compatible, tempo-adjacent, stylistically coherent, energy-correct
for *this point in the set*, and — where data exists — proven in real DJ sets. The DJ can seed
from their own Spotify playlists, preview every candidate, and export the finished set. Nothing
in the core loop requires reading documentation: search → add → follow the curve → export.

## Where V1 actually stands against the requirements (honest baseline)

| Req | State | Gap |
|---|---|---|
| 1 Essential data | BPM ~100%, key ~70%, energy ~70% (estimates), danceability ~70% on back-catalog via MusicBrainz→AcousticBrainz; recent releases (post-mid-2022) often BPM-only via preview analysis | No completeness guarantee, no user-visible data states, energy for new releases unsolved |
| 2 Search | Deezer primary + iTunes fallback; Spotify used for ID lookup after the fact | Coverage/recency unmeasured; remix/version disambiguation weak; no merged multi-source search |
| 3 Recommendations | Engine scores key/BPM/energy/co-occurrence/similarity with explainable reasons | Candidate pool is shallow (seed crate + thin 1001TL index); similarity inactive without LASTFM key; no style/genre signal |
| 4 Set progression | Arc templates (60/120 min) by track COUNT; suggestions respect arc position | No track durations → no real timing; no auto-reorder; no transition guidance; fixed two templates |

## Definition of "working website" (the minimum complete experience)

All four below must hold simultaneously on a fresh machine with the documented keys:

1. **Data**: 100% of tracks *in a set* display all four essentials; tracks missing any are
   marked "incomplete", excluded from scoring (not silently mis-scored), and either resolve
   within 60s or state why they can't.
2. **Search**: ≥90% hit rate on a frozen 100-track benchmark list (50 classics / 50 releases
   from the last 12 months, house/techno/melodic), with original/extended/remix correctly
   distinguished on ≥90% of a 30-case version-pairs list.
3. **Recommendations**: for any in-progress set, ≥8 of the top-10 suggestions are key-compatible
   AND within ±6% tempo AND move energy toward the arc target; every suggestion shows its reasons.
4. **Progression**: the set view shows cumulative time from real durations; the arc adapts to
   the planned set length; the app flags any adjacent pair that violates key/tempo/energy rules
   and can propose a reorder.

## Phases

### Phase 0 — Measure first (3 investigation spikes, no product code)
Blocks everything; cheap; converts the brief's uncertainties into decisions.
- **U1 Search coverage bench**: build the frozen 100-track + 30-version benchmark; run it against
  Deezer, iTunes, Spotify (client-credentials — measure the dev-mode result cap in practice) and
  merged combinations. Output: coverage table → decides P2's provider mix.
- **U2 Essential-data yield bench**: run 100 benchmark tracks through the current resolver;
  measure per-field yield and latency. Test the three candidate energy sources on the same list:
  SoundStat (paid, $0.01/track), full local preview analysis (key+energy via essentia.js, not
  just BPM), ReccoBeats (if back up). Output: per-source yield/cost/latency → decides P1's stack.
- **U3 1001TL index growth**: measure how many tracks/adjacencies a week of polite background
  ingestion actually yields given the site's soft-throttling. Output: expected co-occurrence
  coverage → decides how much P3 leans on it vs similarity/genre.
- Acceptance: a one-page decision memo per uncertainty, committed to docs/research/.

### Phase 1 — Essential-data completeness (Requirement 1) [depends: U2]
The gate concept: a track is `complete | resolving | incomplete(reason)`.
- Resolution pipeline with per-field provenance (exists) + a background re-resolve queue and
  a persistent metadata cache so a track is resolved once, ever.
- UI: completeness badge on every row/card; incomplete tracks excluded from suggestion scoring
  and visually quarantined in the set list; manual override editor (DJ knows best) and
  Mixed In Key tag import (CSV/file) as the pro escape hatch.
- Chosen energy source from U2 wired as the default; local full analysis as fallback if chosen.
- Acceptance: criterion 1 of "working website" holds on the benchmark list end-to-end.

### Phase 2 — Search to Spotify benchmark (Requirement 2) [depends: U1; parallel with P1]
- Merged multi-provider search behind one interface, deduped by ISRC + normalized trackKey,
  ranked by (exact-match, popularity, recency); provider mix per U1 results.
- Version disambiguation: parse and display mix/version (Original/Extended/Remix/Radio) as a
  first-class field; group versions of the same work in results.
- Recency path: whichever provider wins recency in U1 becomes the "new releases" source.
- Acceptance: criterion 2 holds; search p95 latency < 1.5s; zero regressions on the bench.

### Phase 3 — Recommendation depth (Requirement 3) [depends: P1 (clean data); feeds on U3]
- Candidate pool: imported playlists + user's set history + 1001TL neighbors + similar-tracks
  (Last.fm/ListenBrainz) + genre/style filter so suggestions stay in the set's lane.
- Style signal: genre/subgenre per track (Deezer/Spotify genres + Beatport-style taxonomy where
  derivable) feeding a same-lane bonus, so a melodic-house set stops suggesting hard techno.
- "Radio mode" study (per brief): a continuous-chain mode that auto-queues the top suggestion,
  used to evaluate recommendation quality quickly.
- Acceptance: criterion 3 holds on 10 scripted set scenarios; a blind self-test — the owner
  rates top-10 relevance ≥7/10 on 8 of 10 scenarios.

### Phase 4 — Set journey & timing (Requirement 4) [depends: P1, P3]
- Real durations (providers give them; store on Track) → cumulative time, time-based arc
  (any set length, not just 60/120), peak placement by minutes not track index.
- Pair diagnostics: flag adjacent violations (key clash, >±6% tempo, energy crash) inline.
- Auto-order: greedy + local-search reorder of the current crate to best satisfy arc + pair
  rules (the AndrewBarba/setlist pattern from docs/research/mixing-rulebook.md §5).
- Acceptance: criterion 4 holds; auto-order of a shuffled 15-track crate produces zero pair
  violations on the scripted scenarios.

### Phase 5 — Hardening for "product" (cross-cutting, after P1–P4 land)
- The billing/auth path from V1 stays dormant until the four requirements hold; then re-enable
  with the deferred billing fixes (ledgered in V1 reviews) before any real user besides the owner.
- Ops: deploy story (the app currently assumes the owner's machine for 1001TL politeness —
  decide hosted-vs-local split: UI hosted, ingestion local).

## Dependencies summary
U1→P2, U2→P1, U3→P3 weighting; P1→P3→P4; P2 parallel to P1; P5 last. P1+P2 together are the
bulk of "working website"; P3/P4 make it *good*.

## Uncertainties requiring investigation (the register)
1. Spotify client-credentials search: practical result caps for dev-mode apps in 2026 (U1).
2. Energy/danceability for post-2022 releases: SoundStat quality vs essentia.js full analysis
   on 30s previews (key detection accuracy from previews is unproven) (U2).
3. 1001TL polite-ingestion yield under soft-throttling; whether licensed access is worth an
   email to them (U3).
4. Track durations coverage across providers (expected easy; verify during P4 design).
5. Legal posture of analyzing Deezer previews server-side at scale (currently transient,
   uncached; re-check their terms before P1 ships it as the default).

## Implementation options (NOT requirements — evaluate against U-spikes)
- Search providers: Spotify (benchmark coverage; capped dev mode), Deezer (open, weaker
  recency?), iTunes (good catalog, weak search ranking), YouTube Music (no viable API).
  Likely outcome: merged Spotify+Deezer. Decide on U1 data.
- Energy sources: SoundStat / essentia.js local / ReccoBeats / AcousticBrainz (back-catalog
  only). Likely outcome: AcousticBrainz (old) + ONE of SoundStat-or-essentia (new). Decide on U2.
- Co-occurrence: own polite 1001TL index (current), Mixes.wiki MediaWiki API for bulk history,
  licensed 1001TL access (email) if the product grows beyond personal use.
