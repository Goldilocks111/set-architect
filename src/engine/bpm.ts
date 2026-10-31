type Relation = 'direct' | 'half-time' | 'double-time' | 'clash';

const HARD_CAP = 0.06;

const linear = (from: number, to: number) => Math.max(0, 1 - Math.abs(to - from) / from / HARD_CAP);

// Rulebook §2: linear falloff to 0 at ±6%; half/double-time matches scored on the equivalent tempo ×0.9.
export function scoreBpmTransition(
  from: number,
  to: number
): { score: number; relation: Relation } {
  if (!(from > 0) || !(to > 0)) return { score: 0, relation: 'clash' };
  const direct = linear(from, to);
  const double = 0.9 * linear(from * 2, to); // target plays at twice the current tempo
  const half = 0.9 * linear(from / 2, to);
  let best: { score: number; relation: Relation } = { score: direct, relation: 'direct' };
  if (double > best.score) best = { score: double, relation: 'double-time' };
  if (half > best.score) best = { score: half, relation: 'half-time' };
  return best.score > 0 ? best : { score: 0, relation: 'clash' };
}
