# 1001Tracklists access — research verdicts (2026-10-31)

## Official API: NONE
- `/api` → 404; no developer/licensing page; FAQ never mentions an API and Q16 describes their
  anti-scraping (datacenter/TOR/VPN IP-range blocks). "API" rumors = third-party paid scraping
  wrappers (parse.bot, Notte). For licensed data: contact them directly (6-person company, does
  industry partnerships — Music Biz member, 250k+ tracklists).
- No published ToS page at all (only Privacy + FAQ) — no explicit contractual scraping ban, but
  clear technical anti-scraping intent.

## Scraping feasibility: MEDIUM, with a key asymmetry (probed live 2026-10-31)
- **No Cloudflare** — plain Apache, no JS challenge. Tracklist pages return full SSR HTML to bare
  curl from a residential IP (199KB page with all tracks, order, cue times, labels, schema.org microdata).
- **Track detail pages (per-track "appears in these sets") are captcha-gated** — HTTP 401 with a
  homegrown image captcha. DO NOT build on per-track lookups.
- **Architecture consequence**: crawl TRACKLIST pages (discovery via search/artist/genre/recent
  listings), build our own local `track → sets` and `before/after adjacency` index. This sidesteps
  the captcha entirely.

## Mechanics (from TracklistHeroAPI, pushed 2026-09, working today)
- Search: POST `/search/result.php` with `main_search=<query>&search_selection=9`.
  Result rows: `div.bItm.action.oItm` with `.bTitle` + href + date.
- Tracklist URL: `/tracklist/<shortid>/<slug>.html`. Track rows: `div.tlpTog`; name `.trackValue`;
  cue `.cue.noWrap.action.mt5`; position `.fontXL`; remix info `.trackEditData`.
- No dependency-worthy library exists — write our own thin scraper (~100 lines, requests/fetch +
  parser) modeled on TracklistHeroAPI selectors. Reference repos: travage/TracklistHeroAPI (fresh),
  leandertolksdorf/1001-tracklists-api (stale, 58★).

## Operating rules (etiquette + reliability)
- Residential IP only (runs on the owner's machine, not cloud). ~1 request per few seconds, jittered.
- Cache every fetched page to disk/db; never re-fetch. Persist the `guid` cookie.
- Low volume; if this goes commercial/at-scale → email 1001Tracklists about licensed access.

## AJAX track-search endpoint (discovered 2026-10-31 via conrad-scherb/1001-tracklists-scraper, probed live — works, no captcha)
- `GET /ajax/search_track.php?p=<query>&noIDFieldCheck=true&fixedMode=true&sf=p` → JSON:
  `data.<id_unique>.properties` = trackname, fulltrackname, id_unique, id_track, first_played,
  **play_count** (number of sets the track appears in — a direct DJ-popularity signal), artist
  objects (artistname, id_unique), label objects.
- Tracklist-page rows also carry `data-trackid`/`data-trno` attributes → stable internal track ids
  for adjacency (more robust than name matching). V1.1 scraper upgrade: key adjacency by
  data-trackid, enrich tracks with play_count from the ajax search. Track PAGES remain
  captcha-gated — ajax search + tracklist pages still sidestep them. Same politeness rules apply.
- Reference repos reviewed read-only (nothing executed): conrad-scherb/1001-tracklists-scraper
  (stale 2021, but documented the ajax endpoint + SOCKS5 proxy idea), github topic
  `1001tracklists` (nothing else reusable: browser extensions, importers).

## Secondary/bulk sources
- **Mixes.wiki** (revival of MixesDB, 200k+ sets, MediaWiki-based → standard `api.php` likely).
  Most API-friendly bulk source; strong on older/underground sets, weak on cue times.
- set79.com (alive, current festival/club sets); trackid.net (SPA, no documented API);
  WhatsTheID (community IDs for YouTube sets, has API/MCP, small); setlist.fm (official API but
  poor DJ/electronic coverage); lsdb.eu (unverified).
