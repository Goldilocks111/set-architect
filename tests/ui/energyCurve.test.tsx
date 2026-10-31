import { describe, expect, it, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import { buildCurveData } from '@/components/curveData';
import EnergyCurve from '@/components/EnergyCurve';
import { energyTargetAt } from '@/engine';
import type { Track } from '@/types/track';

const t = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  artist: `A${id}`,
  title: `T${id}`,
  sources: {},
  ...extra,
});

describe('buildCurveData', () => {
  it('spans the planned length even with an empty set, target arc from energyTargetAt', () => {
    const rows = buildCurveData([], '60min', 15);
    expect(rows).toHaveLength(15);
    rows.forEach((r, i) => {
      expect(r.position).toBe(i + 1);
      expect(r.target).toBe(energyTargetAt('60min', i, 15));
      expect(r.energy).toBeNull();
      expect(r.bpm).toBeNull();
    });
  });

  it('maps actual energy and bpm per set position', () => {
    const rows = buildCurveData(
      [t('1', { energy: 4, bpm: 122 }), t('2', { energy: 5, bpm: 124 })],
      '60min',
      15
    );
    expect(rows[0]).toMatchObject({ position: 1, energy: 4, bpm: 122, label: 'A1 – T1' });
    expect(rows[1]).toMatchObject({ position: 2, energy: 5, bpm: 124 });
    expect(rows[2].energy).toBeNull();
  });

  it('undefined / NaN energy and bpm become null gaps, never NaN', () => {
    const rows = buildCurveData(
      [t('1', { energy: 4 }), t('2'), t('3', { energy: Number.NaN, bpm: Number.NaN }), t('4', { energy: 6 })],
      '60min',
      15
    );
    expect(rows.slice(0, 4).map((r) => r.energy)).toEqual([4, null, null, 6]);
    expect(rows.slice(0, 4).map((r) => r.bpm)).toEqual([null, null, null, null]);
    for (const r of rows) {
      for (const v of [r.energy, r.bpm, r.target]) {
        if (v !== null) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('extends past the planned length when the set is longer, targets still computed', () => {
    const tracks = Array.from({ length: 18 }, (_, i) => t(String(i), { energy: 5 }));
    const rows = buildCurveData(tracks, '60min', 15);
    expect(rows).toHaveLength(18);
    expect(rows[17].target).toBe(energyTargetAt('60min', 17, 15));
  });

  it('uses the given template for the target arc', () => {
    const rows = buildCurveData([], '120min', 30);
    expect(rows).toHaveLength(30);
    expect(rows[20].target).toBe(energyTargetAt('120min', 20, 30));
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
      <EnergyCurve tracks={[t('1', { energy: 4, bpm: 122 }), t('2'), t('3', { bpm: 125 })]} template="60min" />
    );
    expect(getByRole('figure', { name: /energy curve/i })).toBeInTheDocument();
  });

  it('renders an empty set', () => {
    const { getByText } = render(<EnergyCurve tracks={[]} template="120min" />);
    expect(getByText(/target arc/i)).toBeInTheDocument();
  });
});
