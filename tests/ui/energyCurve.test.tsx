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

describe('buildCurveData', () => {
  it('spans the planned minutes even with an empty set (5:00 slots at 75%), target from the arc at each slot middle', () => {
    const rows = buildCurveData([], BUILD_60);
    expect(rows).toHaveLength(16);
    rows.forEach((r, i) => {
      expect(r.position).toBe(i + 1);
      expect(r.target).toBe(energyTargetAtMinute(BUILD_60, i * 3.75 + 1.875));
      expect(r.energy).toBeNull();
      expect(r.bpm).toBeNull();
    });
  });

  it('maps actual energy and bpm per set position', () => {
    const rows = buildCurveData(
      [t('1', { energy: 4, bpm: 122 }), t('2', { energy: 5, bpm: 124 })],
      BUILD_60
    );
    expect(rows[0]).toMatchObject({ position: 1, energy: 4, bpm: 122, label: 'A1 – T1' });
    expect(rows[1]).toMatchObject({ position: 2, energy: 5, bpm: 124 });
    expect(rows[2].energy).toBeNull();
  });

  it('undefined / NaN energy and bpm become null gaps, never NaN', () => {
    const rows = buildCurveData(
      [t('1', { energy: 4 }), t('2'), t('3', { energy: Number.NaN, bpm: Number.NaN }), t('4', { energy: 6 })],
      BUILD_60
    );
    expect(rows.slice(0, 4).map((r) => r.energy)).toEqual([4, null, null, 6]);
    expect(rows.slice(0, 4).map((r) => r.bpm)).toEqual([null, null, null, null]);
    for (const r of rows) {
      for (const v of [r.energy, r.bpm, r.target]) {
        if (v !== null) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('extends past the planned minutes when the set is longer, targets still computed', () => {
    const tracks = Array.from({ length: 18 }, (_, i) => t(String(i), { energy: 5 }));
    const rows = buildCurveData(tracks, BUILD_60);
    expect(rows).toHaveLength(18);
    expect(rows[17].target).toBe(6);
  });

  it('uses the given arc; 30 tracks of 5:20 reproduce the rulebook 120-minute targets', () => {
    expect(buildCurveData([], JOURNEY_120)).toHaveLength(32);
    const tracks = Array.from({ length: 30 }, (_, i) => t(String(i), { durationMs: 320_000 }));
    const rows = buildCurveData(tracks, JOURNEY_120);
    expect(rows).toHaveLength(30);
    expect(rows[20].target).toBe(9);
    expect(rows[26].target).toBe(10);
  });

  it('open slots continue at the set average length; the play fraction stretches the arc', () => {
    // two 8:00 tracks at 75% = 6:00 each -> open slots of 6' until 60' : 10 rows
    const tracks = [t('1', { durationMs: 480_000 }), t('2', { durationMs: 480_000 })];
    expect(buildCurveData(tracks, BUILD_60)).toHaveLength(10);
    // at 50% each is 4:00 -> 15 rows
    expect(buildCurveData(tracks, BUILD_60, 0.5)).toHaveLength(15);
  });

  it('a 4-hour set draws its slots; absurd tiny durations cannot explode the row count', () => {
    expect(buildCurveData([], { minutes: 240, shape: 'peak-time' })).toHaveLength(64);
    const rows = buildCurveData([t('1', { durationMs: 1 })], { minutes: 480, shape: 'build' });
    expect(rows.length).toBeLessThanOrEqual(201);
    for (const r of rows) expect(Number.isFinite(r.target)).toBe(true);
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

  it('renders an empty set', () => {
    const { getByText } = render(<EnergyCurve tracks={[]} arc={JOURNEY_120} />);
    expect(getByText(/target arc/i)).toBeInTheDocument();
  });
});
