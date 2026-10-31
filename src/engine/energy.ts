import type { ArcTemplate } from '@/types/track';

// Rulebook §3, one target per quarter-hour slot of the 60 min template (T1–T15).
const SIXTY_MIN = [4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 8, 8, 9, 7, 6];

// Rulebook §3, 120 min template as [minute, energy] control points, linearly interpolated.
const ONE_TWENTY_MIN: Array<[number, number]> = [
  [0, 3],
  [20, 5],
  [45, 6],
  [70, 8],
  [78, 9],
  [85, 9],
  [88, 6.5], // deliberate reset after first peak
  [95, 6.5],
  [105, 10], // main peak at ~80-90%
  [108, 10],
  [110, 7],
  [120, 5],
];

function interpolate(points: Array<[number, number]>, x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x0, y0] = points[i - 1];
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

export function energyTargetAt(
  template: ArcTemplate,
  position: number,
  totalPlanned: number
): number {
  const total = Math.max(1, totalPlanned);
  const frac = Math.min(1, Math.max(0, (position + 0.5) / total));
  if (template === '60min') {
    return SIXTY_MIN[Math.min(SIXTY_MIN.length - 1, Math.floor(frac * SIXTY_MIN.length))];
  }
  return Math.round(interpolate(ONE_TWENTY_MIN, frac * 120));
}

const distScore = (dist: number) => (dist <= 1 ? 1 : Math.max(0.3, 1 - 0.25 * (dist - 1)));

// Rulebook §3: one level at a time toward the arc target; +2 is a "Big energy jump" (the
// key-boost exception is applied in suggest.ts); a drop of 2-3 landing near target is a tolerated reset.
export function scoreEnergyTransition(
  fromE: number | undefined,
  toE: number | undefined,
  target: number
): { score: number; label: string } {
  if (toE === undefined) return { score: 0.5, label: 'Energy unknown' };
  const dist = Math.abs(toE - target);
  if (fromE === undefined) {
    return { score: distScore(dist), label: dist <= 1 ? 'Fits arc' : 'Off arc' };
  }
  const delta = toE - fromE;
  if (delta === 2) return { score: 0.4, label: 'Big energy jump' };
  if (delta >= 3) return { score: 0.1, label: 'Big energy jump' };
  if (delta <= -2) {
    // Rulebook §3: only a -2..-3 reset is allowed; anything bigger is an accidental crash.
    if (delta >= -3) {
      return dist <= 1
        ? { score: 0.7, label: 'Energy reset' }
        : { score: delta === -2 ? 0.3 : 0.2, label: 'Energy drop' };
    }
    return { score: 0.1, label: 'Energy crash' };
  }
  const away = dist > Math.abs(fromE - target);
  const score = Math.max(0.1, distScore(dist) - (away && dist > 1 ? 0.15 : 0));
  const label = delta === 0 ? 'Holds energy' : `Energy ${delta > 0 ? '+' : '-'}1`;
  return { score, label };
}
