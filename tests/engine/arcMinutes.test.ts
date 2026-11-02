import { describe, expect, it } from 'vitest';
import {
  energyTargetAtMinute,
  nextTrackTarget,
  plannedTrackCount,
  setPlayedMinutes,
  slotMidMinutes,
  startMinutes,
  trackTargets,
} from '@/engine/energy';
import type { Arc, ArcShape, Track } from '@/types/track';

const track = (id: string, durationMs?: number): Track => ({ id, artist: `A${id}`, title: `T${id}`, sources: {}, durationMs });
/** 5:20 played at 75% = exactly 4:00 per track: the old "~15 tracks per hour" slot. */
const SLOT_MS = 320_000;
const set = (n: number, ms: number | undefined = SLOT_MS) => Array.from({ length: n }, (_, i) => track(String(i), ms));

// Today's energyTargetAt('60min', i, 15) and energyTargetAt('120min', i, 30), captured before the migration.
const LEGACY_60 = [4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 8, 8, 9, 7, 6];
const LEGACY_120 = [3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 6, 7, 7, 7, 8, 8, 9, 9, 9, 8, 7, 7, 8, 9, 10, 7, 6, 5];

const SHAPES: ArcShape[] = ['build', 'journey', 'warm-up', 'peak-time'];

/** Fraction of the set where the curve first reaches its maximum, sampled finely. */
function peakFraction(arc: Arc): number {
  const steps = 2400;
  let best = -Infinity;
  let at = 0;
  for (let s = 0; s <= steps; s++) {
    const e = energyTargetAtMinute(arc, (s / steps) * arc.minutes);
    if (e > best) {
      best = e;
      at = s / steps;
    }
  }
  return at;
}

describe('startMinutes / setPlayedMinutes', () => {
  it('is the cumulative played minutes at each track start', () => {
    expect(startMinutes(set(4))).toEqual([0, 4, 8, 12]);
    expect(setPlayedMinutes(set(4))).toBe(16);
    expect(startMinutes(set(3, 240_000), 0.5)).toEqual([0, 2, 4]);
  });
  it('falls back to 5:00 for a missing or broken duration, never NaN', () => {
    const tracks = [track('a'), track('b', Number.NaN), track('c', -5), track('d', 0), track('e', 400_000)];
    const starts = startMinutes(tracks);
    expect(starts).toEqual([0, 3.75, 7.5, 11.25, 15]);
    expect(setPlayedMinutes(tracks)).toBe(20);
  });
  it('takes the duration source as a parameter (Task 1 durationOf plugs in here)', () => {
    expect(startMinutes(set(3), 1, () => 60_000)).toEqual([0, 1, 2]);
  });
  it('clamps an out-of-range play fraction to 50-100%', () => {
    expect(startMinutes(set(2, 240_000), 0.1)).toEqual([0, 2]);
    expect(startMinutes(set(2, 240_000), 3)).toEqual([0, 4]);
    expect(startMinutes(set(2, 240_000), Number.NaN)).toEqual([0, 3]);
  });
  it('empty set', () => {
    expect(startMinutes([])).toEqual([]);
    expect(setPlayedMinutes([])).toBe(0);
  });
});

describe('plannedTrackCount', () => {
  it('is about minutes / (5.0 x play fraction)', () => {
    expect(plannedTrackCount({ minutes: 60, shape: 'build' })).toBe(16);
    expect(plannedTrackCount({ minutes: 120, shape: 'journey' })).toBe(32);
    expect(plannedTrackCount({ minutes: 60, shape: 'build' }, 1)).toBe(12);
    expect(plannedTrackCount({ minutes: 240, shape: 'peak-time' }, 0.5)).toBe(96);
    expect(plannedTrackCount({ minutes: 15, shape: 'warm-up' })).toBe(4);
  });
});

describe('energyTargetAtMinute', () => {
  it('returns whole energy levels within 1..10 for every shape and length, clamped outside the set', () => {
    for (const shape of SHAPES) {
      for (const minutes of [15, 30, 60, 90, 240, 480]) {
        for (let m = -5; m <= minutes + 5; m += minutes / 37) {
          const e = energyTargetAtMinute({ minutes, shape }, m);
          expect(Number.isInteger(e)).toBe(true);
          expect(e).toBeGreaterThanOrEqual(1);
          expect(e).toBeLessThanOrEqual(10);
        }
        expect(energyTargetAtMinute({ minutes, shape }, -10)).toBe(energyTargetAtMinute({ minutes, shape }, 0));
        expect(energyTargetAtMinute({ minutes, shape }, minutes * 3)).toBe(energyTargetAtMinute({ minutes, shape }, minutes));
      }
    }
  });

  it('every shape keeps its peak at the same fraction of the set for 30, 60 and 240 minutes', () => {
    for (const shape of SHAPES) {
      const ref = peakFraction({ minutes: 60, shape });
      for (const minutes of [30, 240]) expect(Math.abs(peakFraction({ minutes, shape }) - ref)).toBeLessThanOrEqual(1 / 2400);
    }
  });

  it('a 30-minute and a 4-hour build land the peak at the same minute fraction (rulebook ~75-85%)', () => {
    for (const minutes of [30, 240]) {
      const f = peakFraction({ minutes, shape: 'build' });
      expect(f).toBeGreaterThanOrEqual(0.75);
      expect(f).toBeLessThanOrEqual(0.85);
    }
    expect(energyTargetAtMinute({ minutes: 240, shape: 'build' }, 195)).toBe(9);
    expect(energyTargetAtMinute({ minutes: 30, shape: 'build' }, 24.5)).toBe(9);
  });

  it('journey: main peak at ~80-90% after a reset, at any length', () => {
    for (const minutes of [30, 120, 240]) {
      const at = (f: number) => energyTargetAtMinute({ minutes, shape: 'journey' }, f * minutes);
      expect(at(0)).toBe(3);
      expect(at(0.7)).toBeGreaterThanOrEqual(8); // first peak
      expect(at(0.77)).toBeLessThanOrEqual(7); // reset
      expect(at(0.88)).toBe(10); // main peak
      expect(at(1)).toBe(5);
    }
  });

  it('warm-up rises gently from 3 to 6, never more than one level per tenth of the set', () => {
    const arc: Arc = { minutes: 90, shape: 'warm-up' };
    const pts = Array.from({ length: 11 }, (_, i) => energyTargetAtMinute(arc, (i / 10) * 90));
    expect(pts[0]).toBe(3);
    expect(pts[10]).toBe(6);
    expect(Math.max(...pts)).toBe(6);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]).toBeGreaterThanOrEqual(pts[i - 1]);
      expect(pts[i] - pts[i - 1]).toBeLessThanOrEqual(1);
    }
  });

  it('peak-time runs 7 to 10 with exactly one reset', () => {
    const arc: Arc = { minutes: 120, shape: 'peak-time' };
    const pts = Array.from({ length: 121 }, (_, m) => energyTargetAtMinute(arc, m));
    expect(pts[0]).toBe(7);
    expect(Math.min(...pts)).toBe(7);
    expect(Math.max(...pts)).toBe(10);
    expect(pts[120]).toBe(10);
    let drops = 0;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i] < pts[i - 1] && !(pts[i - 1] < pts[i - 2])) drops++;
      expect(pts[i - 1] - pts[i]).toBeLessThanOrEqual(2); // a reset, never a crash
    }
    expect(drops).toBe(1);
  });
});

describe('rulebook equivalence: 15/30 tracks of 5:20 at 75% reproduce the old position targets', () => {
  it("{60,'build'} === energyTargetAt('60min', i, 15)", () => {
    expect(trackTargets({ minutes: 60, shape: 'build' }, set(15))).toEqual(LEGACY_60);
  });
  it("{120,'journey'} === energyTargetAt('120min', i, 30)", () => {
    expect(trackTargets({ minutes: 120, shape: 'journey' }, set(30))).toEqual(LEGACY_120);
  });
  it('the target for the next track equals the old target for that position', () => {
    for (let p = 0; p < 15; p++) expect(nextTrackTarget({ minutes: 60, shape: 'build' }, set(p))).toBe(LEGACY_60[p]);
    for (let p = 0; p < 30; p++) expect(nextTrackTarget({ minutes: 120, shape: 'journey' }, set(p))).toBe(LEGACY_120[p]);
  });
});

describe('slotMidMinutes', () => {
  it('is the middle of each played track, then extra slots of the set average', () => {
    expect(slotMidMinutes(set(2), 2)).toEqual([2, 6, 10, 14]);
    // empty set: extra slots use the 5:00 fallback at 75%
    expect(slotMidMinutes([], 2)).toEqual([1.875, 5.625]);
  });
  it('the next track target follows real durations: long tracks reach the peak sooner', () => {
    const arc: Arc = { minutes: 60, shape: 'build' };
    // 6 tracks of 10:00 at 75% = 45 played minutes; next track mid ≈ 48.75' = 81% -> peak slot (9)
    expect(nextTrackTarget(arc, set(6, 600_000))).toBe(9);
    // 6 tracks of 5:20 = 24 minutes -> still building
    expect(nextTrackTarget(arc, set(6))).toBe(6);
  });
});
