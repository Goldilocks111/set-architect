# Similarity data & preview playback — research verdicts (2026-10-31)

## Spotify: DO NOT BUILD ON IT
- Recommendations, audio-features, audio-analysis, related-artists AND `preview_url` are blocked
  (403/null) for apps created after 2024-11-27. Tightened further: May 2025 stricter extended-access
  review; Feb 2026 dev-mode apps capped at 5 users, search capped at 10 items.
- Chosic works only because it is a grandfathered extended-quota Spotify app (its footer credits
  Spotify AB; its filters mirror Spotify's recommendation parameters 1:1). Not replicable.
- Spotify dev terms also forbid combining Spotify content with other media sources (e.g. YouTube players).

## Similarity sources (ranked)
1. **Last.fm `track.getSimilar`** — API key only, no user auth; match scores from collaborative
   listening data. Free tier is NON-COMMERCIAL only (commercial needs partners@last.fm deal).
   ~5 req/s unofficial limit. → primary for the POC.
2. **ListenBrainz / MetaBrainz labs** — fully open, no commercial restriction:
   labs.api.listenbrainz.org (similar-recordings, similar-artists, tag-similarity, plus ID mapping
   to Spotify/Apple/SoundCloud). Smaller coverage. → open fallback / commercial path.
3. **Deezer** — catalog endpoints still answer unauthenticated (incl. related/radio + 30s preview
   MP3s), but new app registration is closed and support is unguaranteed. → opportunistic fallback only.
4. **Cyanite.ai** — commercial audio-AI similarity, quotation-priced, B2B scale only. Not for POC.

Canonical track identity: **MusicBrainz ID (MBID)** — ListenBrainz endpoints key off it and it maps
to other platforms' IDs.

## Previews (ranked)
1. **iTunes Search API** — free, keyless, returns `previewUrl` (30s AAC). Legal requirements:
   stream-only (no caching), show "Download on iTunes" badge linking to the store near the preview,
   attribute "provided courtesy of iTunes". → primary preview source.
2. **YouTube IFrame Player API** — embedding is legal with the unmodified player, but the player
   must be VISIBLE (≥200×200px, 480×270 recommended), no hidden/background/audio-only use, no
   overlays, one autoplayer per page, Referer header required (error 153 otherwise), no
   caching/downloading. A visible mini-player card per track is compliant; invisible audio preview
   is NOT. Chosic only LINKS out to YouTube rather than embedding. → secondary (full-song listen).
3. **Deezer 30s preview MP3s** — work today without auth, time-limited URLs, murky terms. → best-effort fallback.

## Chosic UX reference (what we're emulating)
Seeds (up to 5: song/artist/genre/mood/playlist or link paste) → generate → suggestion list that
re-rolls per click; sliders for popularity/tempo/similarity dimension; per-track actions: in-page
preview play, YouTube link-out, open-in-platform, save/export playlist. Free, ad-supported.
