import { isComplete } from '@/lib/completeness';
import { DEFAULT_PLAY_FRACTION } from '@/lib/duration';
import type { Arc, Track } from '@/types/track';
import { scoreBpmTransition } from './bpm';
import { parseCamelot, scoreKeyTransition } from './camelot';
import { averagePlayedMinutes, energyTargetAtMinute, setPlayedMinutes, trackTargets } from './energy';
import { pairViolations } from './pairs';

export interface AutoOrderResult {
  order: string[];
  violations: number;
  cost: number;
  feasible: boolean;
  iterations: number;
}

export interface AutoOrderOptions {
  seed?: number;
  /** Pin the current first track as the opener. */
  keepFirst?: boolean;
  /** Pin the current last track as the closer. */
  keepLast?: boolean;
  /** Wall-clock guard for the annealing loop (default AUTO_ORDER_MAX_MS); Infinity leaves it to the iteration budget. */
  maxMs?: number;
  playFraction?: number;
}

/**
 * Default wall-clock guard. The iteration budget decides the result: about 50-150 ms for 15-30 tracks, so the guard
 * only trips on a badly overloaded machine (when it does, the answer is the best found so far and may vary by run).
 */
export const AUTO_ORDER_MAX_MS = 1000;

const VIOLATION = 1000;
const LAMBDA = 0.3;
/** Up to this many movable tracks every order is tried, so the minimum is exact. */
const EXHAUSTIVE_MAX = 7;
const ITERATIONS_PER_TRACK = 2000;
const RESTARTS = 4;
const EXTRA_RUNS = 4;
const T_START = 300;
const T_END = 0.01;

/** Small seeded PRNG (mulberry32): same seed, same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const known = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** Key + tempo score of a literal pair (0..1); a side that can't be scored counts as a neutral 0.5. */
function pairScore(a: Track, b: Track): number {
  const key = parseCamelot(a.camelot) && parseCamelot(b.camelot) ? scoreKeyTransition(a.camelot!, b.camelot!).score : 0.5;
  const bpm = known(a.bpm) && a.bpm > 0 && known(b.bpm) && b.bpm > 0 ? scoreBpmTransition(a.bpm, b.bpm).score : 0.5;
  return (key + bpm) / 2;
}

/**
 * Cost of a set order: 1000 × violations (pairViolations) + Σ (1 − pair score) + 0.3 × Σ |E − target(minute)|, the
 * target read where the engine reads it for that position (trackTargets). Unknown energies add nothing.
 */
export function orderCost(tracks: Track[], arc: Arc, playFraction = DEFAULT_PLAY_FRACTION): number {
  const targets = trackTargets(arc, tracks, playFraction);
  let cost = VIOLATION * pairViolations(tracks).length;
  for (let i = 1; i < tracks.length; i++) cost += 1 - pairScore(tracks[i - 1], tracks[i]);
  tracks.forEach((t, i) => {
    if (known(t.energy)) cost += LAMBDA * Math.abs(t.energy - targets[i]);
  });
  return cost;
}

/**
 * Proposes a set order (rulebook §5, after AndrewBarba/setlist): greedy construction from every opener, then seeded
 * simulated annealing over the best greedy orders with 2-swap, segment-reverse and block-move moves (a block moved
 * without turning it round: boosts and energy steps are directional). Up to 7 movable tracks every order is tried.
 * The result is always a permutation of the input ids. Incomplete tracks (isComplete false) are not reordered: they
 * keep their relative order at the end, before a pinned closer. `feasible` is false when the returned order still has
 * a violation: the exact minimum up to 7 movable tracks, the fewest found beyond. Deterministic per seed: the
 * iteration budget ends the search, unless the maxMs wall-clock guard trips first (tests pass maxMs: Infinity).
 */
export function autoOrder(tracks: Track[], arc: Arc, opts: AutoOrderOptions = {}): AutoOrderResult {
  const n = tracks.length;
  const pf = opts.playFraction ?? DEFAULT_PLAY_FRACTION;
  const rnd = mulberry32(opts.seed ?? 1);
  const maxMs = opts.maxMs ?? AUTO_ORDER_MAX_MS;
  const started = Date.now();

  const head = opts.keepFirst && n > 0 ? [0] : [];
  const tailPin = opts.keepLast && n > 1 ? [n - 1] : [];
  const pinned = new Set([...head, ...tailPin]);
  const free = tracks.map((_, i) => i).filter((i) => !pinned.has(i));
  const movable = free.filter((i) => isComplete(tracks[i]));
  const rest = free.filter((i) => !isComplete(tracks[i]));

  // Pair matrices from the one rule source (pairViolations) and the transition scores.
  const V = tracks.map((a) => tracks.map((b) => (a === b ? 0 : pairViolations([a, b]).length)));
  const S = tracks.map((a) => tracks.map((b) => (a === b ? 0 : 1 - pairScore(a, b))));
  const played = tracks.map((t) => setPlayedMinutes([t], pf));
  const nominal = averagePlayedMinutes([], pf);
  const energy = tracks.map((t) => (known(t.energy) ? t.energy : undefined));

  /**
   * Fills pc[i + 1] (cost of positions 0..i) and pa[i + 1] (minutes played before i + 1) from position `from` on;
   * pc[from] and pa[from] must already hold. The target is read as positionMinutes does: where the set so far ends,
   * plus half its average played track.
   */
  const fill = (order: number[], from: number, pc: Float64Array, pa: Float64Array): number => {
    for (let i = from; i < order.length; i++) {
      const k = order[i];
      const at = pa[i];
      let c = pc[i];
      if (i > 0) c += VIOLATION * V[order[i - 1]][k] + S[order[i - 1]][k];
      const e = energy[k];
      if (e !== undefined) c += LAMBDA * Math.abs(e - energyTargetAtMinute(arc, at + (i ? at / i : nominal) / 2));
      pc[i + 1] = c;
      pa[i + 1] = at + played[k];
    }
    return pc[order.length];
  };
  const cost = (order: number[]) => fill(order, 0, new Float64Array(n + 1), new Float64Array(n + 1));

  const lo = head.length;
  const m = movable.length;
  const assemble = (mid: number[]) => [...head, ...mid, ...rest, ...tailPin];

  let best = assemble(movable);
  let bestCost = cost(best);
  let iterations = 0;
  const consider = (order: number[]) => {
    const c = cost(order);
    if (c < bestCost - 1e-12) {
      best = [...order];
      bestCost = c;
    }
    return c;
  };

  if (m >= 2 && m <= EXHAUSTIVE_MAX) {
    // Heap's algorithm over the movable block
    const mid = [...movable];
    const ctr = new Array(m).fill(0);
    consider(assemble(mid));
    for (let i = 0; i < m; ) {
      if (ctr[i] < i) {
        const j = i % 2 === 0 ? 0 : ctr[i];
        [mid[j], mid[i]] = [mid[i], mid[j]];
        consider(assemble(mid));
        iterations++;
        ctr[i]++;
        i = 0;
      } else {
        ctr[i] = 0;
        i++;
      }
    }
  } else if (m > EXHAUSTIVE_MAX) {
    // Greedy from every opener: the next track is the cheapest step from the last one at its arc position.
    const starts: number[][] = [];
    for (const opener of movable) {
      const mid = [opener];
      const left = new Set(movable.filter((i) => i !== opener));
      let at = head.reduce((s, k) => s + played[k], 0) + played[opener];
      while (left.size) {
        const pos = lo + mid.length;
        const target = energyTargetAtMinute(arc, at + at / pos / 2);
        const prev = mid[mid.length - 1];
        let pick = -1;
        let pickCost = Infinity;
        for (const k of left) {
          const e = energy[k];
          const c = VIOLATION * V[prev][k] + S[prev][k] + (e === undefined ? 0 : LAMBDA * Math.abs(e - target));
          if (c < pickCost) [pick, pickCost] = [k, c];
        }
        mid.push(pick);
        left.delete(pick);
        at += played[pick];
      }
      consider(assemble(mid));
      starts.push(mid);
    }
    starts.sort((a, b) => cost(assemble(a)) - cost(assemble(b)));

    // Annealing: restart from the best greedy orders; the temperature first lets a violation in, then settles.
    const budget = ITERATIONS_PER_TRACK * m;
    const perRun = Math.floor(budget / RESTARTS);
    // While the best order still has a violation, further runs start again from it (up to EXTRA_RUNS more). The soft
    // terms stay below one VIOLATION for any real set (< 1 + 2.7 per track), so cost >= VIOLATION means a violation.
    const runs = () => (bestCost >= VIOLATION ? RESTARTS + EXTRA_RUNS : RESTARTS);
    for (let run = 0; run < runs() && Date.now() - started < maxMs; run++) {
      const order = run < RESTARTS ? assemble(starts[run % starts.length]) : [...best];
      const pc = new Float64Array(n + 1);
      const pa = new Float64Array(n + 1);
      const sc = new Float64Array(n + 1);
      const sa = new Float64Array(n + 1);
      let current = fill(order, 0, pc, pa);
      for (let it = 0; it < perRun; it++) {
        if ((it & 1023) === 0 && Date.now() - started >= maxMs) break;
        iterations++;
        const temp = T_START * Math.pow(T_END / T_START, it / perRun);
        let i = lo + Math.floor(rnd() * m);
        let j = lo + Math.floor(rnd() * m);
        if (i === j) continue;
        if (i > j) [i, j] = [j, i];
        const move = Math.floor(rnd() * 3);
        const r = 1 + Math.floor(rnd() * (j - i)); // rotation size for move 2
        applyMove(order, move, i, j, r);
        // nothing before position i changed: re-cost from there only
        sc[i] = pc[i];
        sa[i] = pa[i];
        const next = fill(order, i, sc, sa);
        const delta = next - current;
        if (delta <= 0 || rnd() < Math.exp(-delta / temp)) {
          current = next;
          pc.set(sc.subarray(i + 1), i + 1);
          pa.set(sa.subarray(i + 1), i + 1);
          if (current < bestCost - 1e-12) {
            best = [...order];
            bestCost = current;
          }
        } else applyMove(order, move, i, j, j - i + 1 - r);
      }
    }
  }

  const ordered = best.map((k) => tracks[k]);
  const violations = pairViolations(ordered).length;
  return { order: ordered.map((t) => t.id), violations, cost: bestCost, feasible: violations === 0, iterations };
}

/**
 * 0: swap i and j, 1: reverse i..j (both their own inverse), 2: rotate i..j left by r, i.e. move the block i..i+r-1
 * after the rest without turning it round (inverse: rotate by length - r).
 */
function applyMove(xs: number[], move: number, i: number, j: number, r: number) {
  if (move === 0) [xs[i], xs[j]] = [xs[j], xs[i]];
  else if (move === 1) reverse(xs, i, j);
  else {
    const seg = xs.slice(i, j + 1);
    for (let k = 0; k < seg.length; k++) xs[i + k] = seg[(k + r) % seg.length];
  }
}

function reverse(xs: number[], i: number, j: number) {
  for (; i < j; i++, j--) [xs[i], xs[j]] = [xs[j], xs[i]];
}
