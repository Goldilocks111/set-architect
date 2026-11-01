# U1 decision: search coverage benchmark (Phase 2)

Date: 2026-11-01. Baseline file: `docs/research/search-bench-baseline-2026-11-01-merged.json`.

## 1. Run conditions
- One run of the merged target: 100 tracks (50 classic, 50 recent) and 30 version cases, from `bench/search/`.
- Providers: Spotify, Deezer and MusicBrainz. iTunes was excluded because it IP-blocks us.
- Request budgets: Spotify 150, Deezer 700 (raised because 260 were already used that day), MusicBrainz 200. Used: Spotify 145, Deezer 405 cumulative that day, MusicBrainz 15.
- Run status ok, 0 errored queries, no 429.
- An earlier "96% / 63%" run is **invalid**: Spotify had been silently degraded in the merged target. The harness now marks such runs INVALID.

## 2. Results against targets

| Measure | Target | Result | Met |
|---|---|---|---|
| Track hit rate | >= 90% | 97% audited (98% raw scorer); classic 98% audited (100% raw), recent 96% | yes |
| Version correctness | >= 90% | 93.3% (28 of 30) | yes |
| Total latency p95 | < 1.5 s | 1240 ms (p50 492 ms) | yes |
| Stage-1 latency | - | p50 489 ms, p95 747 ms | - |
| Stage-2 share | - | 15 of 130 queries | - |

The audit adjustment: `c-benny-benassi-satisfaction` matched "David Guetta, Benny Benassi" at 2:35, which looks like the recent rework and not the 2002 original, so it is counted as a false pass.

## 3. Per-provider evidence (earlier single-provider runs)
- Deezer alone: 95% on tracks but only 30% on versions. It returns plain titles and often no extended mix or remix.
- MusicBrainz closes the version gaps: it lists every recording of a work, with lengths.
- Spotify (dev mode) caps `limit` at 10. Heavy benchmark traffic locked the whole app out for about 13.8 h, so its request volume must stay budgeted.

## 4. Decision
- Stage 1: Spotify and Deezer.
- Stage 2 (only when no strong hit): MusicBrainz plus refined queries; iTunes only as an optional fallback behind the breaker.
- Progressive results (R13) are not needed: total p95 is under 1.5 s.
- Risk: Spotify quota. The app budget is 30 requests per minute, enforced by the breaker.

## 5. Misses and follow-ups
- Track misses: Solardo "Deeper Love" (top result was Steen Thottrup's); Kölsch "Speicher 140" (top result was "Anti Promi Energie").
- Version misses: Fisher "Rain" extended matched a Karanda co-credit with the wrong duration (367.5 s against 266.8 s); "Disclosure Latch Joel Fletcher Remix" ranks unrelated "Disclosure" titles.
- Tighten R15b: the artist-credit subset rule accepts an added lead artist (the Benny Benassi false pass). Also 31 hits matched with additional credited artists ("+extras"); they need a periodic manual look.
- One Spotify degrade (1 of 130 queries) was not attributed to a query; log the query next time.
