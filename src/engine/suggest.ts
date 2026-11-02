import type { Arc, Suggestion, SuggestionReason, Track, Weights } from '@/types/track';
import { trackKeyOf } from '@/types/track';
import { primaryArtist } from '@/lib/primaryArtist';
export { primaryArtist };
import { isEnergyBoostKey, parseCamelot, scoreKeyTransition } from './camelot';
import { scoreBpmTransition } from './bpm';
import { isComplete } from '@/lib/completeness';
import { nextTrackTarget, scoreEnergyTransition } from './energy';
import { isCompliant, isCompliantOpener } from './compliance';
import { laneProfile, styleScore } from './style';

export const DEFAULT_WEIGHTS: Weights = {
  key: 0.25,
  bpm: 0.15,
  energy: 0.2,
  cooccurrence: 0.15,
  similarity: 0.1,
  style: 0.15,
};

const MAX_RESULTS = 10;
const FILTER_THRESHOLD = 0.3;
const UNKNOWN_NEUTRAL = 0.5;
const FLAT_RUN = 4;

const fmt = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10}`;

export function suggestNext(args: {
  playlist: Track[];
  candidates: Track[];
  arc: Arc;
  /** Share of each track played (0.5-1, default 0.75): places the next track on the arc's minute scale. */
  playFraction?: number;
  weights?: Weights;
  adjacency?: Map<string, number>;
  similarity?: Map<string, number>;
  /** Max suggestions returned (default 10). */
  limit?: number;
}): Suggestion[] {
  const w = args.weights ?? DEFAULT_WEIGHTS;
  const { playlist } = args;
  // Incomplete set tracks carry no usable essentials: they never anchor a transition, but still
  // occupy their minutes of the arc and still block re-suggestion.
  const scored = playlist.filter(isComplete);
  const last = scored[scored.length - 1];
  const stillResolving = playlist.length > 0 && !last;
  const target = nextTrackTarget(args.arc, playlist, args.playFraction);
  const inSet = new Set(playlist.map((t) => t.id));
  const recent = scored.slice(-FLAT_RUN);
  const lanes = laneProfile(scored);

  const out: Suggestion[] = [];
  for (const track of args.candidates) {
    if (inSet.has(track.id) || !isComplete(track)) continue;
    const reasons: SuggestionReason[] = [];

    // Key
    let keyScore = UNKNOWN_NEUTRAL;
    let keyKnown = false;
    let boost = false;
    if (last) {
      if (last.camelot && track.camelot) {
        const k = scoreKeyTransition(last.camelot, track.camelot);
        keyKnown = parseCamelot(last.camelot) !== null && parseCamelot(track.camelot) !== null;
        if (keyKnown) {
          keyScore = k.score;
          boost = isEnergyBoostKey(last.camelot, track.camelot);
          reasons.push({ kind: 'key', label: `${k.label} (${last.camelot} → ${track.camelot})`, score: k.score });
        }
      }
      if (!keyKnown) reasons.push({ kind: 'key', label: 'Key unknown', score: UNKNOWN_NEUTRAL });
    }

    // BPM
    let bpmScore = UNKNOWN_NEUTRAL;
    let bpmKnown = false;
    if (last) {
      if (last.bpm && track.bpm) {
        const b = scoreBpmTransition(last.bpm, track.bpm);
        bpmKnown = true;
        bpmScore = b.score;
        const d = track.bpm - last.bpm;
        const rel = b.relation === 'direct' ? `${fmt(d)} BPM` : b.relation === 'clash' ? `${fmt(d)} BPM (clash)` : `${b.relation} match`;
        reasons.push({ kind: 'bpm', label: rel, score: b.score });
      } else {
        reasons.push({ kind: 'bpm', label: 'BPM unknown', score: UNKNOWN_NEUTRAL });
      }
    }

    // Hard filter (rulebook §4); unknown data never counts as failing.
    if (keyKnown && bpmKnown && keyScore < FILTER_THRESHOLD && bpmScore < FILTER_THRESHOLD) continue;

    // Energy
    let energy = scoreEnergyTransition(last?.energy, track.energy, target);
    if (last?.energy !== undefined && track.energy !== undefined) {
      const delta = track.energy - last.energy;
      if (delta >= 2) {
        // Rulebook §3: ΔE +2 only with a Camelot +2 energy boost; +3 or more is never allowed.
        // Unknown key can't be verified, so ΔE +2 keeps the "Big energy jump" score rather than being excluded.
        if (delta >= 3 || (keyKnown && !boost)) continue;
        if (boost && delta === 2) energy = { score: 0.9, label: 'Energy +2 with key boost' };
      }
      // Rulebook §3 / Phase 4 pair rule: a drop of 4 or more is an "Energy crash" — never suggest one.
      if (delta <= -4) continue;
      // Rulebook §3: penalize flat-too-long (>4 tracks at the same energy).
      if (
        delta === 0 &&
        recent.length === FLAT_RUN &&
        recent.every((t) => t.energy === track.energy)
      ) {
        energy = { score: energy.score * 0.6, label: 'Flat too long' };
      }
    }
    reasons.push({
      kind: 'energy',
      label: last
        ? energy.label
        : stillResolving
          ? 'Set tracks still resolving — scored from arc start'
          : energy.label === 'Fits arc'
            ? 'Fits arc start'
            : energy.label,
      score: energy.score,
    });

    // Co-occurrence and similarity
    const tk = trackKeyOf(track.artist, track.title);
    let cooc = 0;
    const count = args.adjacency?.get(tk) ?? 0;
    if (count > 0 && last) {
      cooc = 1 - Math.pow(0.5, count); // 1 set → 0.5, 3 sets → 0.875
      reasons.push({
        kind: 'cooccurrence',
        label: `Played after ${last.title} in ${count} real set${count === 1 ? '' : 's'}`,
        score: cooc,
      });
    }
    let sim = 0;
    const match = args.similarity?.get(tk);
    if (match !== undefined && match > 0) {
      sim = Math.min(1, match);
      reasons.push({ kind: 'similarity', label: `Similar sound (${Math.round(sim * 100)}% match)`, score: sim });
    }

    // Style: lane fit against the recent set; untagged on either side is neutral and gives no reason.
    const st = styleScore(lanes, track);
    const style = st?.score ?? UNKNOWN_NEUTRAL;
    if (st) reasons.push({ kind: 'style', label: st.label ?? 'Nearby lane', score: st.score });

    const score =
      w.key * keyScore +
      w.bpm * bpmScore +
      w.energy * energy.score +
      w.cooccurrence * cooc +
      w.similarity * sim +
      w.style * style;
    const compliant = last ? isCompliant(last, track, target) : isCompliantOpener(track, target);
    out.push({ track, score, reasons, compliant });
  }
  // Criterion 3: every compliant candidate ranks above every non-compliant one; each tier by score.
  return capPerArtist(out.sort(byComplianceThenScore), args.limit ?? MAX_RESULTS);
}

/** At most this many picks per primary artist in the returned list. */
export const MAX_PER_ARTIST = 2;

/**
 * Artist diversity: walks the ranked list in order (compliance tiers stay intact) and skips a candidate once its
 * primary artist already has MAX_PER_ARTIST picks, filling from further down until `limit` are chosen.
 */
export function capPerArtist(ranked: Suggestion[], limit: number, max = MAX_PER_ARTIST): Suggestion[] {
  const counts = new Map<string, number>();
  const out: Suggestion[] = [];
  for (const s of ranked) {
    if (out.length >= limit) break;
    const a = primaryArtist(s.track.artist);
    if (a && (counts.get(a) ?? 0) >= max) continue;
    counts.set(a, (counts.get(a) ?? 0) + 1);
    out.push(s);
  }
  return out;
}

/** Compliant first, then score; suggestions without the flag share the non-compliant tier. */
export function byComplianceThenScore(a: Suggestion, b: Suggestion): number {
  return Number(b.compliant === true) - Number(a.compliant === true) || b.score - a.score;
}
