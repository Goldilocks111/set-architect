# DJ Mixing Rulebook (research-backed, v1)

Source research: web research 2026-10-31. Primary sources verified: Mixed In Key workflow
guides, Last.fm API docs, YouTube API ToS, Apple iTunes Search API docs, ListenBrainz labs API.
This file is the normative spec for the suggestion engine's scoring rules.

## 1. Camelot key compatibility

Notation: `1A`–`12A` (minor, inner ring), `1B`–`12B` (major, outer ring).

Transition scores from current track key `N{A|B}`:

| Transition | Example (from 8A) | Score | Label |
|---|---|---|---|
| Same key | 8A → 8A | 1.00 | Perfect |
| ±1 same letter (wraps 12↔1) | 8A → 7A / 9A | 0.90 | Smooth |
| Ring switch (NA ↔ NB) | 8A → 8B | 0.85 | Relative major/minor |
| +2 same letter | 8A → 10A | 0.60 | Energy boost (tag in UI; "in moderation") |
| Diagonal ±1 with ring switch | 8A → 9B | 0.30 | Risky — sometimes works |
| −3 same letter | 8A → 5A | 0.20 | "Pay attention" mix |
| −5 same letter | 8A → 3A | 0.15 | "Jaws" mix — dramatic |
| Anything else | — | 0.00 | Clash |

Notes:
- "Energy boost" step size varies by vendor (DJ.Studio/KeyPal use +1/+7); Mixed In Key's +2 is authoritative — we use +2.
- Wheel is a guide, not a substitute for listening — UI should say why a suggestion matches, never claim it's guaranteed.
- Sources: mixedinkey.com/workflows/how-to-use-the-camelot-wheel/, dj.studio/blog/camelot-wheel, zipdj.com/blog/camelot-wheel

## 2. BPM compatibility

- Default match window: **±3%** of current BPM (SetFlow's rule). Hard cap ±6%.
- 1–2 BPM delta = seamless; 3–5 = pitch adjust; >5 BPM (~>4%) = deliberate technique only.
- **Half/double-time equivalence**: 85 ≈ 170 — compute compatibility against both `bpm` and `bpm*2` / `bpm/2`, tag suggestion "half-time"/"double-time" when used.
- Genre BPM ranges (for seeding/filtering): House 118–130 (core 124–128), Tech/bass house 124–130, Techno 125–140, Trance 132–140, Dubstep ~140 (70 half), DnB 160–180 (modern 170–175), UKG 130–135, Hip-hop 80–100. 57% of 90k dance tracks fall in 120–140; mode = exactly 128 (Ghent Univ.).

BPM score: 1.0 at delta 0, linear falloff to 0 at ±6%; half/double-time matches scored on the equivalent tempo ×0.9.

## 3. Energy arc (Mixed In Key 1–10 scale)

- Move **one level at a time** by default (|ΔE| ≤ 1). ΔE = +2 allowed only together with a Camelot energy-boost transition. One deliberate reset (−2..−3) allowed after a peak.
- Bands: 1–4 warmup/reset, 5–6 groove, 7–8 build, 9–10 peak.
- Work in blocks of 3–4 tracks at similar energy before stepping up. Never open at peak; peak lands in the final third.

Arc templates (~15 tracks/hour):
- **60 min (~15 tracks)**: T1–3 warmup E4–5 → T4–7 groove E5–6 → T8–11 build E6–8 → T12–13 peak E8–9 (~75–85% through) → T14–15 cooldown E7→6.
- **120 min (~30 tracks)**: 0–20' warmup E3–5 → 20–45' groove E5–6 → 45–70' build E6–8 → 70–85' first peak E8–9 → 85–95' reset E6–7 → 95–110' second build/peak E8–10 (main peak ~80–90%) → 110–120' cooldown E7→5.

Energy score for a candidate: 1.0 if it moves toward the arc target for the playlist position with |ΔE| ≤ 1; penalties for flat-too-long (>4 tracks same E) and accidental drops.

## 4. Composite suggestion score (v1)

`score = w_key * keyScore + w_bpm * bpmScore + w_energy * energyScore + w_cooc * cooccurrenceScore + w_sim * similarityScore`

Default weights (tunable): key 0.30, bpm 0.20, energy 0.20, co-occurrence 0.20, similarity 0.10.
Candidates below keyScore 0.3 AND bpmScore 0.3 are filtered out before ranking (the
commercial pattern — Mixed In Key DJ Mix Mode / SetFlow: filter by compatible key AND BPM ±3%
AND energy ±1, then rank).

Every suggestion carries human-readable reasons: e.g. "Same Camelot key (8A) · +1 BPM · energy +1 · played after this track in 3 sets on 1001Tracklists".

## 5. Reference literature

- Bittner et al., *Automatic Playlist Sequencing and Transitions*, ISMIR 2017 — ismir2017.smcnus.org/wp-content/uploads/2017/10/86_Paper.pdf
- Vande Veire & De Bie, auto-DJ for DnB, EURASIP 2018 — link.springer.com/article/10.1186/s13636-018-0134-8
- Gebhardt/Davies/Seeber, psychoacoustic harmonic mixing, DOI 10.3390/app6050123
- Maçãs et al. 2018, force-directed track graph — cdv.dei.uc.pt/wp-content/uploads/2020/03/macas2018c.pdf
- github.com/AndrewBarba/setlist — greedy + simulated-annealing ordering over key/BPM scores (reusable design for "auto-order my playlist")
