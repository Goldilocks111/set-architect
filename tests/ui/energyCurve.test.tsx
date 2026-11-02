import { describe, expect, it, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import { buildCurveData } from '@/components/curveData';
import EnergyCurve from '@/components/EnergyCurve';
import { energyTargetAtMinute } from '@/engine';
import type { Track } from '@/types/track';

const BUILD_60 = { minutes: 60, shape: 'build' } as const;
const JOURNEY_120 = { minutes: 120, shape: 'journey' } as const;

const t = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  artist: `A${id}`,
  title: `T${id}`,
  sources: {},
  ...extra,
});

describe('buildCurveData (by minute)', () => {
  const samplesOf = (rows: ReturnType<typeof buildCurveData>['points']) => rows.filter((r) => r.position === null);

  it('an empty set spans the planned minutes, target from the arc at each minute, no energy', () => {
    const d = buildCurveData([], BUILD_60);
    expect(d.points).toHaveLength(61);
    d.points.forEach((r, i) => {
      expect(r.minute).toBe(i);
      expect(r.target).toBe(energyTargetAtMinute(BUILD_60, i));
      expect(r.energy).toBeNull();
      expect(r.bpm).toBeNull();
    });
  });

  it('maps energy and bpm to the minutes each track plays (5:00 estimated at 75% = 3:45 each)', () => {
    const d = buildCurveData([t('1', { energy: 4, bpm: 122 }), t('2', { energy: 5, bpm: 124 })], BUILD_60);
    const at = (m: number) => d.points.find((p) => p.minute === m)!;
    expect(at(1)).toMatchObject({ position: 1, energy: 4, bpm: 122, label: 'A1 – T1' });
    expect(at(5)).toMatchObject({ position: 2, energy: 5, bpm: 124 });
    expect(at(8)).toMatchObject({ position: null, energy: null });
  });

  it('undefined / NaN energy and bpm become null gaps, never NaN', () => {
    const d = buildCurveData(
      [t('1', { energy: 4 }), t('2'), t('3', { energy: Number.NaN, bpm: Number.NaN }), t('4', { energy: 6 })],
      BUILD_60
    );
    const energyOf = (pos: number) => [...new Set(d.points.filter((p) => p.position === pos).map((p) => p.energy))];
    expect([1, 2, 3, 4].map(energyOf)).toEqual([[4], [null], [null], [6]]);
    for (const r of d.points) {
      for (const v of [r.energy, r.bpm, r.target]) if (v !== null) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('a longer set extends the x-axis; 120-minute journey targets come straight from the engine', () => {
    const tracks = Array.from({ length: 30 }, (_, i) => t(String(i), { durationMs: 320_000 }));
    const d = buildCurveData(tracks, JOURNEY_120);
    expect(d.maxMin).toBe(120); // 30 x 4:00 played
    expect(d.points.find((p) => p.minute === 105)!.target).toBe(energyTargetAtMinute(JOURNEY_120, 105));
  });

  it('the play fraction moves the track starts', () => {
    const tracks = [t('1', { durationMs: 480_000 }), t('2', { durationMs: 480_000 })];
    const startOf2 = (pf: number) => buildCurveData(tracks, BUILD_60, pf).points.find((p) => p.position === 2)!.minute;
    expect(startOf2(0.75)).toBe(6);
    expect(startOf2(0.5)).toBe(4);
  });

  it('a 4-hour set samples 241 minutes; absurd tiny durations cannot explode the point count', () => {
    expect(samplesOf(buildCurveData([], { minutes: 240, shape: 'peak-time' }).points)).toHaveLength(241);
    const d = buildCurveData([t('1', { durationMs: 1 })], { minutes: 480, shape: 'build' });
    expect(d.points.length).toBeLessThanOrEqual(485);
    for (const r of d.points) if (r.target !== null) expect(Number.isFinite(r.target)).toBe(true);
  });
});

describe('<EnergyCurve />', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it('renders with partial-data tracks without crashing', () => {
    const { getByRole } = render(
      <EnergyCurve tracks={[t('1', { energy: 4, bpm: 122 }), t('2'), t('3', { bpm: 125 })]} arc={BUILD_60} />
    );
    expect(getByRole('figure', { name: /energy curve/i })).toBeInTheDocument();
  });

  it('labels the overrun only when the set plays past the planned length', () => {
    const long = Array.from({ length: 9 }, (_, i) => t(String(i), { durationMs: 240_000, energy: 5 }));
    const { getByText, rerender, queryByText } = render(<EnergyCurve tracks={long} arc={{ minutes: 30, shape: 'build' }} playFraction={1} />);
    expect(getByText('Past the planned length')).toBeInTheDocument();
    rerender(<EnergyCurve tracks={long} arc={BUILD_60} playFraction={1} />);
    expect(queryByText('Past the planned length')).toBeNull();
  });

  it('renders an empty set', () => {
    const { getByText } = render(<EnergyCurve tracks={[]} arc={JOURNEY_120} />);
    expect(getByText(/target arc/i)).toBeInTheDocument();
  });
});
