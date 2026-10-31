# Audio features (BPM / key / energy / danceability) — source verdicts (2026-10-31)

Spotify audio-features/recommendations/previews: confirmed dead for new apps (official blog
2024-11-27; 403s verified; dev-mode now capped at 5 users). Chosic/Tunebat ride grandfathered
access and are bot-blocked — not programmatic options.

## Verdict table (live-tested where noted)

| Source | Gives | Access | Cost | Verdict |
|---|---|---|---|---|
| **SoundStat** (soundstat.info) | BPM, key+mode, energy, danceability, valence + segments | REST, free reg → API key | $0.01/track (repeats free) or $15/mo for 2k | **Primary full-features source** — only replacement with published cheap pricing |
| **ReccoBeats** | Spotify-style estimates, by Spotify ID or audio upload | REST, no key | Free | Best-effort fill only — was hard-down (CF 1033) when live-tested; no SLA |
| **GetSongBPM** | BPM, key, time sig | REST, free key, **mandatory visible backlink** | Free | Free BPM/key fallback; patchy on underground electronic |
| **Deezer** | `rank` (popularity), ISRC, 30s preview MP3, release date — **bpm field is 0 in practice** (live-tested on Daft Punk, CDW) | REST, no auth, ~50 req/5s | Free | Enrichment backbone: search, popularity, ISRC, previews. Never use its bpm |
| **iTunes Search** | previewUrl (30s), catalog match | REST, keyless | Free | Primary preview (needs iTunes badge + attribution) |
| **MusicBrainz** | canonical IDs, ISRC links | REST, 1 req/s | Free | ID backbone |
| **AcousticBrainz dump** | BPM/key/danceability per MBID, CC0 | bulk download (verified live) | Free | Optional offline back-catalog (frozen mid-2022) |
| Beatport v4 | exact BPM/key/genre for EDM | **No new API keys issued** | partner-only | Skip (unofficial client_id hack is ToS-risky) |
| Tunebat Platform (new 2026) | Camelot key, BPM, energy from uploaded audio | official async API, SDK Oct 2026 | unpublished (docs DNS dead) | Watch; email support@tunebat.com |
| Cyanite / Soundcharts | full features | sales-gated | enterprise $$ | Skip for POC |
| Apple Music API | no BPM/key/energy at all | $99/yr | — | Skip |
| **Local: Essentia** | BPM, key→Camelot, energy/danceability models | Python lib | Free (AGPL) | Future-proof path when user has audio files |
| **Local: Mixed In Key tags** | Camelot key, Energy 1–10, BPM in ID3 tags | desktop app | $58 once | If the owner's library is MIK-tagged, read tags directly — best quality |

## Key conversion
APIs return pitch-class 0–11 + mode (Spotify convention). Camelot = fixed 24-entry lookup —
implement once in the engine; only Tunebat/MIK output Camelot natively.

## Resolver design (decided)
`resolveTrack(artist, title)` tries, in order, caching everything in the DB:
1. Deezer search → canonical match, ISRC, popularity, preview, artwork
2. iTunes search → previewUrl fallback + store badge link
3. GetSongBPM → bpm, key (if key configured)
4. SoundStat → energy, danceability, bpm/key override (if key configured)
5. ReccoBeats → fill any gaps, best-effort with short timeout
6. Manual override / MIK tag import always wins
Each source is an adapter behind one interface; missing keys mean the adapter reports
"unconfigured" instead of failing. YouTube links: constructed search URLs client-side (free)
rather than Data API searches (100 units each) unless YOUTUBE_API_KEY is present (the owner has one).
