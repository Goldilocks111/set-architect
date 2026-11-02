# U2 decision: data-yield benchmark and local preview analysis

Date: 2026-11-02. Bench: `bench/data/run.ts` (result JSON gitignored). Tuning: `bench/data/tune/`.

## 1. Run conditions
- 100 tracks (50 classic, 50 recent) from `bench/search/tracks.json`, resolved by the app's resolver; status ok, no 429.
- Providers live: Spotify (search only → spotifyId), Deezer, MusicBrainz, AcousticBrainz, ReccoBeats. iTunes off (IP blocks);
  **SoundStat not measured** (no key; the owner chose free-first).
- Local analysis: Deezer 30 s preview fetched transiently, decoded and analysed in memory, never written to disk (97 of 100 had one).
- Accuracy reference: provider values only (ReccoBeats 47, AcousticBrainz 1), never our own analysis. 48 labelled tracks.
- Tuning added two fetch passes (97 + 48 Deezer searches; 347 of the 382 allowed that day) and stored only derived numbers.

## 2. Yield, latency, cost

| Essentials present | Providers only (all / classic / recent) | With local analysis (all / classic / recent) |
|---|---|---|
| bpm, energy, danceability | 48% / 94% / 2% | 97% / 100% / 94% |
| key (camelot) | 48% / 94% / 2% | 89% / 100% / 78% |
| all four (complete) | 48% / 94% / 2% | 89% / 100% / 78% |

- Fields supplied: ReccoBeats 188 (classics only: it needs a spotifyId *with* features), local analysis 188, AcousticBrainz 4.
- Latency: resolve p50 2.7 s, p95 7.5 s; local analysis p50 636 ms, p95 1538 ms (the tuned analyser is not slower).
- Cost: everything above is free. SoundStat would be the only paid source.

## 3. Local analysis accuracy, before → after tuning (held out)

| Field | Target | Before (untuned) | After (held out) |
|---|---|---|---|
| Key exact+relative | ≥ 60% | 32% (12/38) | **56%** (22/39), nested leave-one-out over 384 configs |
| Key miss | ≤ 20% | 42% | **28%** (11/39); fifth 6, no key 9 |
| Key yield (all analysed) | ≥ 80% | 81% | 85% |
| Energy MAE (1–10) | ≤ 1.0 | 1.00 | **1.02**, nested leave-one-out: **target not demonstrated** |
| Danceability MAE | ≤ 0.12 | 0.148 | **0.083**, nested leave-one-out (met) |

- **Key changes shipped:** pitch bins averaged rather than summed, whitening against a ±6-semitone mean, and the Temperley profile.
  They only work together. Alone, from the old analyser, mean averaging gives +6 points, Temperley +4, and whitening −4.
  Removing one from the shipped combination costs 7 (whitening), 12 (mean averaging) or 20 (Temperley) points. Levers tried and dropped: FIR anti-aliasing (no change), HPSS, log magnitude, tuning-offset
  correction, tonalness weighting, frequency ranges, minor bias. A verification pass running the shipped code end to end
  reproduced the held-out key result exactly.
- **The key target is not met.** The reference is noisy too: it says major for 28 of the 48 club tracks, and most remaining
  misses are harmonic neighbours (5 fifth+mode, 3 two-fifths).
- **Energy** = loudness + share of power above 5 kHz. The single-level leave-one-out MAE of that model is 0.96, but the feature set
  was chosen among 13 candidates on that same leave-one-out, so 0.96 is optimistic. With the set chosen inside each fold, the MAE
  is **1.02**. That is about the old placeholder (1.00) and better than predicting the mean (1.15), but it does not show the ≤ 1.0
  target. Even this nested number is mildly optimistic: the highRatio candidates were added after looking at correlations.
- **Danceability** barely varies on club tracks. Nested selection picks the constant model in 38 of 48 folds (MAE 0.083), and the
  shipped fit scores 0.085, so treat danceability as a weak signal.

## 4. Decision
- **Local analysis is the default for every missing field** (bpm, key, energy, danceability). It is free, adds about 0.6 s, and
  takes recent releases from 2% to 78% complete.
- **SoundStat fallback: recommended for key only**, because local key accuracy stays under target (56% / 28% against 60% / 20%).
  Use it only when no provider key exists, and only after the owner approves the cost. It keys off spotifyId, which recent tracks
  have. Do not add it for bpm or danceability, whose targets are met locally. Energy is not demonstrated (1.02), but it is no worse
  than before. If energy precision matters, test SoundStat energy in the same trial as key. Until then, label local keys "estimated".

## 5. Deezer API terms: server-side analysis of previews
Source: Deezer, "Terms of use of Deezer for Developers" (developers.deezer.com/termsofuse, read 2026-11-02; the page gives no
revision date). The terms say nothing about analysing or processing audio. The relevant clause is §IV (Non-commercial use):

> use of the Services is "strictly limited for a non-commercial purpose and in a non-commercial environment."
> "The use of the Content is limited to a strictly private use within a family scope."

§V bans bypassing DRM to download Content. We download nothing beyond the public preview, store no audio and keep only derived
numbers, so §V is not engaged. §IX says any other use needs Deezer's prior approval.

**Verdict (uncertainty 5/10):** transient in-memory analysis for the owner's personal, non-commercial use is defensible: nothing
forbids it explicitly and nothing is stored. **A paid product (Stripe plumbing exists) would breach §IV**, because it derives value
from Content commercially. Before any paid launch, get Deezer's written approval under §IX, or move key/energy analysis to a
licensed source (SoundStat, or user-supplied audio). The quotes came through a page-to-text tool, so check the wording on the live
page before relying on it.

## 6. Erratum (2026-11-02, later the same day)
The Deezer and Spotify enrichment adapters accepted the first result by the right **artist** without
checking the title, so for a track a provider lacked, another song by that artist could supply the
preview (→ local key/energy/danceability) and the Spotify id (→ ReccoBeats reference values). Fixed in
Phase 3 Task 8 (`src/lib/sources/match.ts`: artist + title + version identity). Some rows of the run in
§1–§3 may therefore compare the wrong recordings; the accuracy numbers are provisional until the
Phase 1 acceptance run (cold cache, fixed matcher) and a re-run of the U2 bench reproduce them.
Pre-fix caches were moved to `~/.setarchitect/backup-2026-11-02-prematchfix/`.
