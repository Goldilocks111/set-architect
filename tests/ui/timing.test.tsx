import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import Builder from '@/components/Builder';
import SetList from '@/components/SetList';
import { STORAGE_KEY } from '@/components/persistence';
import { buildCurveData, minuteTicks, overrunText, setTiming, timingHeaderText } from '@/components/curveData';
import { OVERRUN_Z_INDEX } from '@/components/EnergyCurve';
import { DefaultZIndexes } from 'recharts';
import { transitionParts } from '@/components/TransitionBadge';
import { sanitizeTrack } from '@/components/trackSanitize';
import { energyTargetAtMinute, plannedTrackCount, startMinutes } from '@/engine';
import type { Arc, Track } from '@/types/track';

const tr = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  artist: `Artist ${id}`,
  title: `Title ${id}`,
  camelot: '8A',
  bpm: 124,
  energy: 5,
  danceability: 0.6,
  sources: {},
  ...extra,
});
const ARC_60: Arc = { minutes: 60, shape: 'build' };
// 4:00 real, no duration (estimated 5:00), 3:20 real
const mixed = [tr('a', { durationMs: 240_000 }), tr('b'), tr('c', { durationMs: 200_000 })];

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('setTiming', () => {
  it('cumulative played starts with mixed real/estimated durations at 75%, same as the engine startMinutes', () => {
    const t = setTiming(mixed, ARC_60, 0.75);
    expect(t.tracks.map((r) => r.startMin)).toEqual([0, 3, 6.75]);
    expect(t.tracks.map((r) => r.startMin)).toEqual(startMinutes(mixed, 0.75));
    expect(t.tracks.map((r) => r.durationMs)).toEqual([240_000, 300_000, 200_000]);
    expect(t.tracks.map((r) => r.estimated)).toEqual([false, true, false]);
    expect(t.playedMin).toBeCloseTo(9.25);
    expect(t.estimated).toBe(true);
    expect(t.plannedMin).toBe(60);
    expect(t.overrunMin).toBe(0);
  });

  it('at 100% the starts are the full lengths', () => {
    const t = setTiming(mixed, ARC_60, 1);
    expect(t.tracks.map((r) => r.startMin)).toEqual([0, 4, 9]);
    expect(t.playedMin).toBeCloseTo(12 + 1 / 3);
  });

  it('no NaN with zero tracks or all-missing durations', () => {
    const empty = setTiming([], ARC_60);
    expect(empty).toMatchObject({ tracks: [], playedMin: 0, estimated: false, overrunMin: 0 });
    const t = setTiming([tr('a', { durationMs: Number.NaN }), tr('b', { durationMs: 0 })], ARC_60);
    for (const r of t.tracks) {
      expect(Number.isFinite(r.startMin)).toBe(true);
      expect(r.estimated).toBe(true);
    }
    expect(Number.isFinite(t.playedMin)).toBe(true);
  });
});

describe('header text', () => {
  it('real durations: "m:ss of planned · N of ~M tracks"', () => {
    const tracks = [tr('a', { durationMs: 240_000 }), tr('b', { durationMs: 200_000 })];
    const t = setTiming(tracks, { minutes: 30, shape: 'build' }, 1);
    expect(timingHeaderText(t, tracks.length, plannedTrackCount({ minutes: 30, shape: 'build' }, 1))).toBe(
      '7:20 of 30 min · 2 of ~6 tracks'
    );
    expect(overrunText(t)).toBeNull();
  });

  it('marks the played time "~" when any duration is estimated', () => {
    const t = setTiming(mixed, ARC_60, 0.75);
    expect(timingHeaderText(t, 3, 16)).toBe('~9:15 of 60 min · 3 of ~16 tracks');
  });

  it('empty set', () => {
    expect(timingHeaderText(setTiming([], ARC_60), 0, 16)).toBe('0:00 of 60 min · 0 of ~16 tracks');
  });

  it('overrun reads "+m:ss over"', () => {
    const tracks = [...Array.from({ length: 7 }, (_, i) => tr(String(i), { durationMs: 240_000 })), tr('x', { durationMs: 370_000 })];
    const t = setTiming(tracks, { minutes: 30, shape: 'build' }, 1);
    expect(timingHeaderText(t, 8, 6)).toBe('34:10 of 30 min · 8 of ~6 tracks');
    expect(overrunText(t)).toBe('+4:10 over');
  });
});

describe('<SetList /> row timing', () => {
  it('each row shows start · length; estimated lengths get "~" and an "estimated" hint', () => {
    render(<SetList tracks={mixed} arc={ARC_60} playFraction={0.75} onRemove={() => {}} onMove={() => {}} />);
    const rows = within(screen.getByRole('list', { name: 'Set list' })).getAllByRole('listitem');
    const timing = rows.map((r) => r.querySelector('[data-timing]')!);
    expect(timing.map((el) => el.getAttribute('data-timing'))).toEqual(['0:00 · 4:00', '3:00 · ~5:00', '6:45 · 3:20']);
    const titles = (el: Element) => [...el.querySelectorAll('[title]')].map((n) => n.getAttribute('title')).join(' | ');
    expect(titles(timing[1])).toMatch(/estimated/i);
    expect(titles(timing[0])).not.toMatch(/estimated/i);
    expect(timing[1].textContent).toMatch(/estimated/i); // screen-reader hint
    expect(timing[0].textContent).not.toMatch(/estimated/i);
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});

describe('<Builder /> timing header', () => {
  async function renderBuilder(state: object) {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ suggestions: [] })));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    await act(async () => {
      render(<Builder demo getSongBpmConfigured={false} />);
    });
  }

  it('shows played of planned and the track count', async () => {
    await renderBuilder({ arc: ARC_60, playFraction: 0.75, tracks: mixed });
    expect(screen.getByText('~9:15 of 60 min · 3 of ~16 tracks')).toBeInTheDocument();
    expect(screen.queryByText(/over$/)).toBeNull();
  });

  it('flags an overrun', async () => {
    const tracks = [...Array.from({ length: 7 }, (_, i) => tr(String(i), { durationMs: 240_000 })), tr('x', { durationMs: 370_000 })];
    await renderBuilder({ arc: { minutes: 30, shape: 'build' }, playFraction: 1, tracks });
    expect(screen.getByText('34:10 of 30 min · 8 of ~6 tracks')).toBeInTheDocument();
    expect(screen.getByText('+4:10 over')).toBeInTheDocument();
  });
});

describe('buildCurveData by minute', () => {
  for (const minutes of [30, 60, 240]) {
    it(`samples the target every minute across a ${minutes}-min arc, with the engine target`, () => {
      const arc: Arc = { minutes, shape: 'peak-time' };
      const d = buildCurveData([], arc);
      expect(d.plannedMin).toBe(minutes);
      expect(d.maxMin).toBe(minutes);
      expect(d.overrun).toBeNull();
      const samples = d.points.filter((p) => p.target !== null);
      expect(samples.map((p) => p.minute)).toEqual(Array.from({ length: minutes + 1 }, (_, i) => i));
      for (const p of samples) expect(p.target).toBe(energyTargetAtMinute(arc, p.minute));
      expect(d.points.every((p) => p.energy === null && !p.overrun)).toBe(true);
    });
  }

  it('set energy is a step: a point at each track start and end, inner samples carry the covering track', () => {
    const tracks = [tr('a', { durationMs: 240_000, energy: 4 }), tr('b', { durationMs: 200_000, energy: 6 })];
    const d = buildCurveData(tracks, ARC_60, 1);
    const at = (m: number) => d.points.filter((p) => Math.abs(p.minute - m) < 1e-9);
    // track a 0..4, b 4..7:20
    expect(at(0).map((p) => p.energy)).toEqual([4]);
    expect(at(2).map((p) => [p.energy, p.position])).toEqual([[4, 1]]);
    // at the boundary: a's end then b's start (vertical step)
    expect(at(4).map((p) => [p.energy, p.position])).toEqual([[4, 1], [6, 2]]);
    expect(at(22 / 3).map((p) => [p.energy, p.position])).toEqual([[6, 2]]);
    expect(at(8).map((p) => p.energy)).toEqual([null]); // after the set
    expect(at(4)[1].label).toBe('Artist b – Title b');
    // sorted by minute
    const mins = d.points.map((p) => p.minute);
    expect([...mins].sort((x, y) => x - y)).toEqual(mins);
  });

  it('unknown-energy tracks leave a gap, not a 0; incomplete-free NaN never appears', () => {
    const tracks = [tr('a', { durationMs: 240_000, energy: 4 }), tr('b', { durationMs: 240_000, energy: undefined }), tr('c', { durationMs: 240_000, energy: Number.NaN })];
    const d = buildCurveData(tracks, ARC_60, 1);
    const inB = d.points.filter((p) => p.position === 2 || p.position === 3);
    expect(inB.length).toBeGreaterThan(0);
    expect(inB.every((p) => p.energy === null)).toBe(true);
    for (const p of d.points) for (const v of [p.minute, p.energy, p.target, p.bpm]) if (v !== null) expect(Number.isFinite(v)).toBe(true);
  });

  it('beyond the planned length: x runs to the played end, points are flagged overrun and carry no target', () => {
    const tracks = Array.from({ length: 9 }, (_, i) => tr(String(i), { durationMs: 240_000 })); // 36' at 100%
    const d = buildCurveData(tracks, { minutes: 30, shape: 'build' }, 1);
    expect(d.maxMin).toBe(36);
    expect(d.overrun).toEqual({ from: 30, to: 36 });
    for (const p of d.points) {
      expect(p.overrun).toBe(p.minute > 30);
      if (p.minute > 30) expect(p.target).toBeNull();
      else expect(p.target).toBe(energyTargetAtMinute({ minutes: 30, shape: 'build' }, p.minute));
    }
    expect(d.points.some((p) => p.overrun && p.energy === 5)).toBe(true);
  });
});

describe('carried minors', () => {
  it('a 90-minute duration (allowed by overrides) survives the client sanitizer; > 2 h is dropped', () => {
    expect(sanitizeTrack({ id: 'x', artist: 'A', title: 'B', durationMs: 5_400_000 })?.durationMs).toBe(5_400_000);
    expect(sanitizeTrack({ id: 'x', artist: 'A', title: 'B', durationMs: 7_200_000 })?.durationMs).toBe(7_200_000);
    expect(sanitizeTrack({ id: 'x', artist: 'A', title: 'B', durationMs: 7_200_001 })?.durationMs).toBeUndefined();
  });

  it('tempo colour follows the ±6% relation at the exact boundary', () => {
    const at6 = transitionParts({ from: tr('a', { bpm: 100 }), to: tr('b', { bpm: 106 }), target: 5 })[1];
    expect(at6.detail).toBe('direct mix');
    expect(at6.tone).toBe('ok');
    const half6 = transitionParts({ from: tr('a', { bpm: 100 }), to: tr('b', { bpm: 53 }), target: 5 })[1];
    expect(half6.detail).toBe('half-time mix');
    expect(half6.tone).toBe('ok');
    const over = transitionParts({ from: tr('a', { bpm: 100 }), to: tr('b', { bpm: 107 }), target: 5 })[1];
    expect(over.detail).toBe('Tempo clash');
    expect(over.tone).toBe('poor');
    const close = transitionParts({ from: tr('a', { bpm: 124 }), to: tr('b', { bpm: 124 }), target: 5 })[1];
    expect(close.tone).toBe('good');
  });
});

describe('fix round 1', () => {
  const ARC_30: Arc = { minutes: 30, shape: 'build' };
  it('header pill and curve shading share one whole-second overrun threshold (0.4 s over = not over)', () => {
    const under = [tr('a', { durationMs: 1_800_400 })]; // 30:00.4 played at 100%
    const tu = setTiming(under, ARC_30, 1);
    expect(overrunText(tu)).toBeNull();
    const du = buildCurveData(under, ARC_30, 1);
    expect(du.overrun).toBeNull();
    expect(du.maxMin).toBe(30);
    expect(du.points.some((p) => p.overrun)).toBe(false);

    const over = [tr('a', { durationMs: 1_800_600 })]; // 30:00.6 -> rounds to 30:01
    const to = setTiming(over, ARC_30, 1);
    expect(overrunText(to)).toBe('+0:01 over');
    const d = buildCurveData(over, ARC_30, 1);
    expect(d.overrun).not.toBeNull();
    expect(d.points.some((p) => p.overrun)).toBe(true);
  });

  it('minuteTicks stays readable for any length, even a pathological 10 000-minute overrun', () => {
    for (const max of [30, 60, 120, 240, 480, 1_000, 10_000]) {
      const ticks = minuteTicks(max);
      expect(ticks[0]).toBe(0);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(9);
      expect(ticks.at(-1)!).toBeLessThanOrEqual(max);
    }
    expect(minuteTicks(60)).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });

  it('the overrun shading paints above the BPM area and below the energy lines', () => {
    expect(OVERRUN_Z_INDEX).toBeGreaterThan(DefaultZIndexes.area);
    expect(OVERRUN_Z_INDEX).toBeLessThan(DefaultZIndexes.line);
  });
});
