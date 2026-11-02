# V2 Phase 4 — Set journey & timing: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. Execute your own task only. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The set view shows cumulative time from real durations; the energy arc follows the planned set length in
minutes (any length) with peaks placed by minute; every adjacent pair that breaks a key/tempo/energy rule is flagged
inline; and the app can propose a reorder of the set that removes those violations.

**Architecture:** Durations become a first-class (non-essential) field filled by the enrichment adapters and cached.
The arc moves from two track-count templates to `{ minutes, shape }` with targets computed by *minute*, where each
track's start minute = cumulative played time (duration × play fraction). A pure `pairViolations(set, arc)` drives
inline flags and a set summary; a pure seeded `autoOrder(set, arc)` (greedy construction + simulated-annealing swaps,
per rulebook §5 / AndrewBarba/setlist) proposes an order the DJ previews, applies or undoes.

**Tech Stack:** TypeScript, Next.js 16, React 19, Recharts, Vitest. No new dependencies.

**Spec:** `docs/specs/2026-11-01-v2-product-plan.md` (Phase 4, criterion 4). Rules: `docs/research/mixing-rulebook.md`.

## Global Constraints

- Criterion 4 (verbatim): "the set view shows cumulative time from real durations; the arc adapts to the planned set
  length; the app flags any adjacent pair that violates key/tempo/energy rules and can propose a reorder."
- Phase 4 acceptance (verbatim): "criterion 4 holds; auto-order of a shuffled 15-track crate produces zero pair
  violations on the scripted scenarios."
- Pair violation (exact): key — `scoreKeyTransition` score < 0.6 (anything but Perfect/Smooth/Energy boost/Relative);
  tempo — not within ±6% incl. half/double-time; energy — ΔE ≥ +3, or +2 without a Camelot +2 boost, or a drop ≤ −4
  ("Energy crash"). Unknown values never count as violations (shown as "?").
- Frozen contract changes approved for this phase ONLY: `ArcTemplate` is replaced by
  `Arc = { minutes: number; shape: ArcShape }` with `ArcShape = 'build' | 'journey' | 'warm-up' | 'peak-time'`
  (`'60min'` → `{60,'build'}`, `'120min'` → `{120,'journey'}` migrations everywhere incl. localStorage, saved sets,
  bench scenarios); `Track.durationMs` already exists.
- Provider quotas as in CLAUDE.md; no new provider calls just for durations (take them from responses already fetched).
- All runtime writes via `dataDir()`; unit tests network-mocked; never print `.env`; commits by
  `Goldilocks111@users.noreply.github.com`, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never `git add -A`.

## Review Focus

1. Tracks with no duration: timing still renders (estimate shown as "~6:00", marked estimated) and never NaN — Task 1/4 tests.
2. A 4-hour (240 min) or 30-min set: arc targets scale; peak lands at the shape's minute fraction — Task 2 tests.
3. Reordering must never drop, duplicate or silently change tracks; undo restores the exact previous order — Task 4 tests.
4. Auto-order on an infeasible crate (no zero-violation order exists) returns the minimum-violation order and says so — Task 4 test.
5. Old saved state (template '60min'/'120min') loads without loss — Task 2 migration tests.

---

## Wave 1 (parallel)

### Task 1: Durations everywhere
**Files:** `src/lib/sources/{deezer,spotify,musicbrainz}.ts` (fill `durationMs` from the responses they already fetch: Deezer `duration` s→ms, Spotify `duration_ms`, MusicBrainz `length`), `src/lib/metadataCache.ts` (persist), Spotify import mapping (`duration_ms`), MIK CSV (`Time`/`Duration`/`Length` column "m:ss" if present); create `src/lib/duration.ts`:
```ts
export const DEFAULT_PLAY_FRACTION = 0.75;
export function estimatedDurationMs(t: Pick<Track,'version'|'title'>): number; // extended/club/original-mix → 6:30, radio/edit → 3:30, else 5:00
export function durationOf(t: Track): { ms: number; estimated: boolean };
export function formatMinutes(ms: number): string; // "m:ss" / "h:mm:ss"
```
- [ ] Tests (mocked responses) per adapter; cache persistence; estimate rules; formatting. Commit.

### Task 2: Minute-based arc
**Files:** `src/types/track.ts` (Arc, ArcShape; remove ArcTemplate usages), `src/engine/energy.ts`, all callers (`suggest.ts`, `compliance.ts`, `assemble.ts`, route, `TransitionBadge.tsx`, `EnergyCurve.tsx`/`curveData.ts`, `playlistReducer.ts`, `persistence.ts`, `SavedSets`, bench scenarios + recs bench); replace `ArcTemplatePicker` with `ArcPicker` (length presets 30/60/90/120/180/240 + custom 15–480, shape select).
```ts
export function energyTargetAtMinute(arc: Arc, minute: number): number; // shapes as minute-fraction control points; 'build' = rulebook 60-min curve, 'journey' = rulebook 120-min curve, 'warm-up' = 3→6 gentle, 'peak-time' = 7→10 with one reset
export function startMinutes(tracks: Track[], playFraction?: number): number[]; // cumulative played minutes at each track start (durationOf × fraction)
export function plannedTrackCount(arc: Arc, playFraction?: number): number; // ≈ minutes / (5.0 × fraction), for "N of ~M tracks"
```
- [ ] Failing tests: shapes scale to 30/60/240 min (peak minute fraction preserved); `'60min'`/`'120min'` migration in reducer load, localStorage, saved sets; engine/compliance use minute targets (existing rulebook tests updated only for the signature, values unchanged for 60/120 equivalents); play fraction setting (50–100%, default 75%) persisted. Commit.

## Wave 2 (after Wave 1; parallel)

### Task 3: Pair diagnostics inline
**Files:** create `src/engine/pairs.ts`; modify `TransitionBadge.tsx`, `SetList.tsx`/`SetRow.tsx`, `Builder.tsx` (summary).
```ts
export type PairIssue = { kind: 'key' | 'tempo' | 'energy'; label: string };
export function pairViolations(tracks: Track[], arc: Arc): Array<{ index: number; issues: PairIssue[] }>; // index = position of the incoming track
```
- [ ] Tests: the exact violation rules above (incl. Camelot wrap, half/double-time, +2 with/without boost, crash ≤ −4); unknown values never violate; incomplete tracks skipped (pair formed with the previous complete track? NO — pairs are literal neighbours; an incomplete neighbour yields "?" not a violation). UI: violating transitions get a warning style + text ("Key clash 8A→3B"); header summary "2 rough transitions" with a button that scrolls to the first. Commit.

### Task 4: Auto-order (propose → preview → apply/undo)
**Files:** create `src/engine/autoOrder.ts`, `src/components/AutoOrderPanel.tsx`; modify `playlistReducer.ts` (`applyOrder`, `undoOrder`), `Builder.tsx`.
```ts
export interface AutoOrderResult { order: string[]; violations: number; cost: number; feasible: boolean; iterations: number }
export function autoOrder(tracks: Track[], arc: Arc, opts?: { seed?: number; keepFirst?: boolean; keepLast?: boolean; maxMs?: number }): AutoOrderResult;
```
Cost = 1000 × violations + Σ (1 − pair score) + λ·Σ |E − target(minute)| (λ = 0.3). Greedy construction from the best opener, then simulated annealing with 2-swap and segment-reverse moves, seeded, ≤ 300 ms for 30 tracks. Incomplete tracks keep their relative position at the end (documented).
- [ ] Failing tests: Review Focus 3 & 4; determinism by seed; keepFirst/keepLast; acceptance property: 10 scripted 15-track crates built from a known zero-violation chain then shuffled (seeded) → autoOrder finds 0 violations on all 10; runtime bound. UI: "Suggest order" → preview (diff: moved tracks highlighted, before/after violation counts) → Apply / Cancel; Undo after apply. Commit.

## Wave 3

### Task 5: Timing UI
**Files:** `SetRow.tsx` (start time "0:00 / 4:52…", duration, "~" when estimated), `Builder.tsx` header ("38:20 of 60:00 · 9 of ~16 tracks"), `EnergyCurve.tsx`/`curveData.ts` (x-axis in minutes; target curve by minute across the planned length; set energy as a step line at track start minutes; overrun shaded).
- [ ] Tests: cumulative times with mixed real/estimated durations; header text; curve data points by minute; overrun beyond planned length. Browser check by controller. Commit.
