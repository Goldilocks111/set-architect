# Set Architect

Set Architect helps a DJ build a set track by track against an energy arc (60 or 120 minute templates). It shows key (Camelot) and tempo compatibility between neighbouring tracks, plays previews, and suggests next tracks drawn from real DJ-set adjacency (what actually follows what in published tracklists), similarity data and the harmonic/tempo/energy rules in the engine.

## Quickstart (demo mode, zero keys)

```bash
npm i
npm run dev
```

Open http://localhost:3000. With no environment variables the app runs in demo mode: a seeded track catalogue, seeded adjacency data, and the set is kept in your browser. No accounts, no billing, no network keys.

Other scripts: `npm test` (vitest), `npm run build`, `npx tsc --noEmit`.

## Activating features

Copy `.env.example` to `.env` and fill in what you want. Real values live only in `.env` (gitignored).

| Env var(s) | Unlocks |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Leaves demo mode: accounts, saved sets, free-tier limits (one saved set, 20 suggestions per UTC day). Apply `supabase/migrations/` first. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO` (plus `NEXT_PUBLIC_APP_URL`) | Billing: checkout, customer portal, webhook, Pro plan removes free limits. |
| _(none needed)_ | BPM, key, danceability and an energy estimate now work with zero keys for most catalogue tracks: MusicBrainz maps the track to a recording ID and AcousticBrainz (a frozen 2022 snapshot, CC0) supplies tempo and key. Energy from this route is a loudness-based estimate and is recorded as `acousticbrainz-estimate` in the track's provenance. Tracks neither knows about get a tempo estimated from the Deezer 30-second preview (decoded in memory, never stored; cached in `data/index/analysis.json`). |
| `GETSONGBPM_API_KEY` | Optional enhancer: real BPM and key lookups that take priority over the keyless sources. The builder footer then shows the required getsongbpm.com backlink automatically. |
| `LASTFM_API_KEY` | Track similarity for suggestions. |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Spotify catalog search (client credentials): resolves each track's Spotify ID and adds an "Open in Spotify" link. That ID is what activates ReccoBeats, which then supplies energy and danceability for free. |
| `SOUNDSTAT_API_KEY` | Energy, danceability, and better BPM/key. Needs a Spotify ID, so it comes alive once the Spotify credentials above are set. ReccoBeats (keyless) covers the same fields when this key is absent. |
| `YOUTUBE_API_KEY` | Richer YouTube links. Without it, links fall back to YouTube search URLs. |

Every music-data adapter disables itself when its key is empty. Previews come from iTunes (credited in the footer) with Deezer as fallback.

## Connect your Spotify

The header's **Connect Spotify** button signs a user in with Spotify (authorization-code flow, server-side) so they can import their playlists into the builder and save the current set back as a private Spotify playlist. It works in demo mode too; it is independent of Supabase.

1. Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env` (same app as the catalog lookup).
2. **Required manual step.** In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), open your app, then Settings, then Redirect URIs, and add both:
   - `http://localhost:3000/api/spotify/callback`
   - `http://localhost:3001/api/spotify/callback`

   The redirect URI is derived from the request origin, so whichever port the dev server is on must be registered exactly. In production, set `SPOTIFY_REDIRECT_URI` to the exact registered callback URL; it is then used verbatim instead of the request's Host-derived origin.
3. Optional: set `SPOTIFY_COOKIE_SECRET` (any long random string). Tokens are stored only in an AES-256-GCM encrypted, httpOnly cookie; the key is derived from this secret, falling back to `SPOTIFY_CLIENT_SECRET`, then to a fixed dev-only value outside production. Production refuses to start the flow without one of the two secrets.

Scopes requested: `playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private`. Only playlist and profile endpoints are called; Spotify's audio-features and recommendations endpoints are deprecated and never used.

**Dev-mode cap:** a Spotify app in development mode only allows 5 users, who must each be added by email under the app's User Management. Anyone else gets a 403 at login or on the first API call. Lifting the cap needs Spotify's extended-quota review.

## Tracklist scraper

The scraper builds the adjacency index (`data/index/`) from public DJ tracklists.

```bash
npm run scrape -- search "artist or event"
npm run scrape -- tracklist <url> [<url>...]
npm run scrape -- crawl "<query>" --max 20
npm run scrape -- stats
npm run scrape -- demo     # regenerate data/seed/adjacency.demo.json
```

Etiquette: requests are spaced 2 to 4 seconds apart (jittered, and the gap also holds across separate runs), pages are cached on disk so nothing is fetched twice, the crawl identifies itself with an honest User-Agent, and it aborts immediately on 401, 403 or 429 rather than retrying. Keep crawls small (`--max`), do not run several at once, and respect the source site's terms. Only derived adjacency counts are stored, not page content.

## Architecture

- `src/engine/` pure scoring logic: Camelot key distance, BPM compatibility, energy arc fit, and the suggestion ranker. No I/O.
- `src/lib/sources/` one adapter per external provider (GetSongBPM, MusicBrainz, AcousticBrainz, Last.fm, SoundStat, ReccoBeats, Deezer, iTunes, YouTube, ListenBrainz), each self-disabling without its key. `src/lib/resolver.ts` combines them into a single track record.
- `src/lib/adjacency/` the "what follows what" index: JSON store, demo seed generator, loader.
- `scripts/scraper/` the CLI that fills the adjacency index.
- `src/app/` Next.js App Router: the builder page, `/api/search`, `/api/suggest`, `/api/playlists`, `/api/stripe/*`, auth and admin pages. `src/components/` is the builder UI.
- `src/lib/supabase/`, `src/lib/billing/` accounts, entitlements and Stripe.
- `tests/` vitest suites mirroring the above.

## Production notes

- Demo mode is decided by whether the two public Supabase variables are present. If they go missing in a deployment (misconfigured or lost environment), the app silently falls back to demo mode: users appear signed out and the free-tier limits are not enforced. Add a deploy-time guard that fails the build or boot when production is missing these variables.
- Outside demo mode, entitlement checks fail closed: if Supabase is unreachable or the service role key is missing, saving a set and `/api/suggest` return 503.
- `/api/suggest` limits apply only to signed-in free users. Demo mode and anonymous callers are not rate limited in V1; add rate limiting before exposing it publicly.
- Stripe routes run on the default Node runtime and are dynamic, so webhook signature verification sees the raw body.

## Data credits

Set Architect combines several generous data sources:

- BPM and key data by [GetSongBPM](https://getsongbpm.com) — thank you for the free API. Keyless fallback data from [MusicBrainz](https://musicbrainz.org) (CC0) and the [AcousticBrainz](https://acousticbrainz.org) archive (CC0).
- Track previews provided courtesy of [iTunes / Apple Music](https://www.apple.com/itunes/); catalog search and popularity via [Deezer](https://www.deezer.com); similar-track data via [Last.fm](https://www.last.fm) and [ListenBrainz](https://listenbrainz.org).
- Set co-occurrence ideas inspired by the DJ community on [1001Tracklists](https://www.1001tracklists.com) (indexed politely and locally; see docs/research/ for the etiquette rules).
