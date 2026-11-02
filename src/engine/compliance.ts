import type { Track } from '@/types/track';
import { parseCamelot, scoreKeyTransition } from './camelot';

/** Rulebook §1: Perfect 1, Smooth 0.9, Relative 0.85, Energy boost 0.6 are mixable; Risky/Jaws/Clash are not. */
const KEY_COMPATIBLE = 0.6;
/** Rulebook §2 hard cap, inclusive, against the direct, half-time or double-time equivalent tempo. */
const BPM_CAP = 0.06;
const EPS = 1e-9;

const known = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

export function isKeyCompatible(from: string | undefined, to: string | undefined): boolean {
  if (!parseCamelot(from) || !parseCamelot(to)) return false;
  return scoreKeyTransition(from!, to!).score >= KEY_COMPATIBLE;
}

export function isTempoCompatible(from: number | undefined, to: number | undefined): boolean {
  if (!known(from) || !known(to) || from <= 0 || to <= 0) return false;
  return [1, 2, 0.5].some((r) => Math.abs(to - from * r) <= from * r * BPM_CAP + EPS);
}

/** Energy that closes on the arc target, or already sits within one level of it. */
export function movesTowardTarget(fromE: number | undefined, toE: number | undefined, target: number): boolean {
  if (!known(fromE) || !known(toE)) return false;
  const dist = Math.abs(toE - target);
  return dist <= Math.abs(fromE - target) || dist <= 1;
}

/**
 * Criterion 3: key-compatible AND within ±6% tempo (incl. half/double-time) AND energy toward the arc target.
 * A value missing on either side can't be verified, so it is not compliant.
 */
export function isCompliant(last: Track, cand: Track, target: number): boolean {
  return (
    isKeyCompatible(last.camelot, cand.camelot) &&
    isTempoCompatible(last.bpm, cand.bpm) &&
    movesTowardTarget(last.energy, cand.energy, target)
  );
}

/** First track of a set (no anchor): only the arc can be checked — energy within one level of the target. */
export function isCompliantOpener(cand: Track, target: number): boolean {
  return known(cand.energy) && Math.abs(cand.energy - target) <= 1;
}
