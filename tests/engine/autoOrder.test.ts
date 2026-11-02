import { describe, expect, it } from 'vitest';
import { AUTO_ORDER_MAX_MS, autoOrder, mulberry32, orderCost } from '@/engine/autoOrder';
import { pairViolations, trackTargets } from '@/engine';
import type { Arc, Track } from '@/types/track';

const build: Arc = { minutes: 60, shape: 'build' };
const t = (id: string, camelot?: string, bpm?: number, energy?: number, extra: Partial<Track> = {}): Track => ({
  id, artist: `A${id}`, title: `T${id}`, camelot, bpm, energy, danceability: 0.6, durationMs: 360_000, sources: {}, ...extra,
});
/** Correctness runs without the wall-clock guard: the iteration budget alone decides, so a loaded box can't change the answer. */
const exact = { maxMs: Infinity } as const;
const byIds = (tracks: Track[], ids: string[]) => ids.map((id) => tracks.find((x) => x.id === id)!);

function shuffle<T>(xs: T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A known zero-violation chain: walks the Camelot wheel with Perfect / Smooth / Energy-boost moves, BPM steps within
 * ±3%, energy following the arc target one level at a time (never more than +1).
 */
function scriptedChain(seed: number, n = 15, arc: Arc = build): Track[] {
  const rnd = mulberry32(1000 + seed);
  let num = 1 + Math.floor(rnd() * 12);
  const letter = rnd() < 0.5 ? 'A' : 'B';
  let bpm = 120 + rnd() * 8;
  const out: Track[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const move = Math.floor(rnd() * 4); // 0 perfect, 1 smooth +1, 2 smooth -1, 3 boost +2
      num = (((num - 1 + [0, 1, -1, 2][move]) % 12) + 12) % 12 + 1;
      bpm = bpm * (1 + (rnd() * 2 - 1) * 0.03);
    }
    const durationMs = Math.round((300 + rnd() * 120) * 1000);
    const draft = [...out, t(`s${seed}-${i}`, `${num}${letter}`, Math.round(bpm * 10) / 10, 0, { durationMs })];
    const target = trackTargets(arc, draft)[i];
    const prev = out[i - 1]?.energy ?? target;
    draft[i].energy = prev + Math.max(-1, Math.min(1, target - prev));
    out.push(draft[i]);
  }
  return out;
}

describe('scripted acceptance: shuffled 15-track crates from a known zero-violation chain', () => {
  for (let seed = 1; seed <= 10; seed++) {
    it(`crate seed ${seed} → 0 violations`, () => {
      const chain = scriptedChain(seed);
      expect(pairViolations(chain)).toEqual([]); // the fixture really is a zero-violation chain
      const crate = shuffle(chain, seed);
      expect(pairViolations(crate).length).toBeGreaterThan(0);
      const r = autoOrder(crate, build, { seed: 1, ...exact });
      const after = pairViolations(byIds(crate, r.order)).length;
      expect(r.violations).toBe(after);
      expect(after).toBe(0);
      expect(r.feasible).toBe(true);
    });
  }
});

describe('autoOrder', () => {
  it('Review Focus 3: always a permutation — never drops, duplicates or changes tracks', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rnd = mulberry32(seed);
      const crate = Array.from({ length: 2 + Math.floor(rnd() * 20) }, (_, i) =>
        rnd() < 0.2
          ? t(`x${i}`, undefined, 124) // incomplete
          : t(`x${i}`, `${1 + Math.floor(rnd() * 12)}${rnd() < 0.5 ? 'A' : 'B'}`, 118 + rnd() * 14, 1 + Math.floor(rnd() * 10))
      );
      const r = autoOrder(crate, build, { seed, ...exact });
      expect([...r.order].sort()).toEqual(crate.map((x) => x.id).sort());
      expect(new Set(r.order).size).toBe(crate.length);
    }
  });

  it('Review Focus 4: an infeasible crate returns the minimum-violation order and says so', () => {
    // 3B clashes with 8A: it can only sit at one end, touching one 8A track → exactly 1 violation is the minimum
    const crate = [t('a', '8A', 128, 5), t('x', '3B', 128, 5), t('b', '8A', 128, 5), t('c', '8A', 128, 5), t('d', '8A', 128, 5)];
    const r = autoOrder(crate, build, { seed: 3, ...exact });
    expect(r.violations).toBe(1);
    expect(r.feasible).toBe(false);
    expect([r.order[0], r.order[4]]).toContain('x');
    // every pair clashes: n - 1 is the minimum
    const all = [t('p', '1A', 128, 5), t('q', '4A', 128, 5), t('r', '7A', 128, 5), t('s', '10A', 128, 5)];
    const r2 = autoOrder(all, build, { seed: 3, ...exact });
    expect(r2.violations).toBe(3);
    expect(r2.feasible).toBe(false);
  });

  it('is deterministic by seed', () => {
    const crate = shuffle(scriptedChain(4, 20), 9);
    const a = autoOrder(crate, build, { seed: 42, ...exact });
    const b = autoOrder(crate, build, { seed: 42, ...exact });
    expect(b).toEqual(a);
  });

  it('keepFirst / keepLast pin the current opener and closer', () => {
    const crate = shuffle(scriptedChain(5), 2);
    const first = autoOrder(crate, build, { seed: 1, keepFirst: true, ...exact });
    expect(first.order[0]).toBe(crate[0].id);
    const last = autoOrder(crate, build, { seed: 1, keepLast: true, ...exact });
    expect(last.order.at(-1)).toBe(crate.at(-1)!.id);
    const both = autoOrder(crate, build, { seed: 1, keepFirst: true, keepLast: true, ...exact });
    expect(both.order[0]).toBe(crate[0].id);
    expect(both.order.at(-1)).toBe(crate.at(-1)!.id);
    expect([...both.order].sort()).toEqual(crate.map((x) => x.id).sort());
  });

  it('incomplete tracks keep their relative order at the end', () => {
    const crate = [t('i1', '8A'), t('a', '8A', 128, 5), t('i2', undefined, 128, 5), t('b', '9A', 128, 6), t('i3')];
    const r = autoOrder(crate, build, { seed: 1, ...exact });
    expect(r.order.slice(-3)).toEqual(['i1', 'i2', 'i3']);
  });

  it('reports the cost of the order it returns (orderCost: 1000·violations + Σ(1 − pair) + 0.3·Σ|E − target|)', () => {
    const crate = shuffle(scriptedChain(6), 6);
    const r = autoOrder(crate, build, { seed: 1, ...exact });
    expect(r.cost).toBeCloseTo(orderCost(byIds(crate, r.order), build), 6);
    expect(r.cost).toBeLessThanOrEqual(orderCost(crate, build) + 1e-9);
    // the violation term is exactly 1000 per pairViolations entry
    const bad = [t('a', '8A', 128, 5), t('b', '3B', 128, 5)];
    expect(orderCost(bad, build) - orderCost([bad[0], { ...bad[1], camelot: '8A' }], build)).toBeGreaterThan(999);
  });

  it('handles trivial crates', () => {
    expect(autoOrder([], build).order).toEqual([]);
    expect(autoOrder([t('a', '8A', 128, 5)], build).order).toEqual(['a']);
  });

  it('runtime: the iteration budget finishes a 30-track crate well inside the app guard (generous bound)', () => {
    const crate = shuffle([...scriptedChain(7, 15), ...scriptedChain(8, 15)], 7);
    const t0 = performance.now();
    const r = autoOrder(crate, { minutes: 120, shape: 'journey' }, { seed: 1, ...exact });
    expect(performance.now() - t0).toBeLessThan(AUTO_ORDER_MAX_MS);
    expect(r.order).toHaveLength(30);
    expect(r.iterations).toBeGreaterThan(0);
  });

  it('the wall-clock guard ends the search early and still returns a full permutation', () => {
    const crate = shuffle([...scriptedChain(7, 15), ...scriptedChain(8, 15)], 7);
    const full = autoOrder(crate, build, { seed: 1, ...exact });
    const cut = autoOrder(crate, build, { seed: 1, maxMs: 0 });
    expect(cut.iterations).toBeLessThan(full.iterations);
    expect([...cut.order].sort()).toEqual(crate.map((x) => x.id).sort());
    expect(AUTO_ORDER_MAX_MS).toBe(1000);
  });
});
