import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ArcPicker from '@/components/ArcPicker';
import Builder from '@/components/Builder';
import { STORAGE_KEY } from '@/components/persistence';
import type { Arc, Track } from '@/types/track';

const BUILD_60: Arc = { minutes: 60, shape: 'build' };

function setup(arc: Arc = BUILD_60, playFraction = 0.75) {
  const onChange = vi.fn();
  const onPlayFractionChange = vi.fn();
  render(<ArcPicker value={arc} onChange={onChange} playFraction={playFraction} onPlayFractionChange={onPlayFractionChange} />);
  return { onChange, onPlayFractionChange };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('<ArcPicker />', () => {
  it('offers the 30/60/90/120/180/240 presets as a labelled radio group with the current one checked', () => {
    setup({ minutes: 120, shape: 'journey' });
    const group = screen.getByRole('radiogroup', { name: 'Set length' });
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['30 min', '60 min', '90 min', '120 min', '180 min', '240 min']);
    expect(screen.getByRole('radio', { name: '120 min' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '60 min' })).toHaveAttribute('aria-checked', 'false');
    // roving tab stop: only the checked preset is in the tab order
    expect(screen.getByRole('radio', { name: '120 min' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: '60 min' })).toHaveAttribute('tabindex', '-1');
  });

  it('a preset click keeps the shape', () => {
    const { onChange } = setup({ minutes: 60, shape: 'peak-time' });
    fireEvent.click(screen.getByRole('radio', { name: '90 min' }));
    expect(onChange).toHaveBeenCalledWith({ minutes: 90, shape: 'peak-time' });
  });

  it('arrow keys move between presets (wrapping), Home/End jump', () => {
    const { onChange } = setup();
    const sixty = screen.getByRole('radio', { name: '60 min' });
    fireEvent.keyDown(sixty, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith({ minutes: 90, shape: 'build' });
    fireEvent.keyDown(sixty, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith({ minutes: 30, shape: 'build' });
    fireEvent.keyDown(sixty, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith({ minutes: 240, shape: 'build' });
    fireEvent.keyDown(screen.getByRole('radio', { name: '30 min' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith({ minutes: 240, shape: 'build' });
  });

  it('a custom length (15-480) commits on Enter or blur and is clamped', () => {
    const { onChange } = setup();
    const input = screen.getByLabelText('Custom length in minutes');
    expect(input).toHaveAttribute('min', '15');
    expect(input).toHaveAttribute('max', '480');
    fireEvent.change(input, { target: { value: '75' } });
    expect(onChange).not.toHaveBeenCalled(); // no jump while typing
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ minutes: 75, shape: 'build' });
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({ minutes: 15, shape: 'build' });
    fireEvent.change(input, { target: { value: '900' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({ minutes: 480, shape: 'build' });
  });

  it('a non-preset length shows in the custom field and no preset is checked', () => {
    setup({ minutes: 75, shape: 'build' });
    expect(screen.getByLabelText('Custom length in minutes')).toHaveValue(75);
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
  });

  it('an empty or junk custom value reverts without a change', () => {
    const { onChange } = setup();
    const input = screen.getByLabelText('Custom length in minutes');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the shape select changes the shape and keeps the length', () => {
    const { onChange } = setup({ minutes: 180, shape: 'build' });
    const select = screen.getByLabelText('Arc shape');
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual(['build', 'journey', 'warm-up', 'peak-time']);
    fireEvent.change(select, { target: { value: 'warm-up' } });
    expect(onChange).toHaveBeenCalledWith({ minutes: 180, shape: 'warm-up' });
  });

  it('play fraction: 50-100% of each track, default 75%', () => {
    const { onPlayFractionChange } = setup();
    const select = screen.getByLabelText('Played per track') as HTMLSelectElement;
    expect(select.value).toBe('0.75');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['50%', '60%', '70%', '75%', '80%', '90%', '100%']);
    fireEvent.change(select, { target: { value: '0.6' } });
    expect(onPlayFractionChange).toHaveBeenCalledWith(0.6);
  });
});

describe('Builder with a minute arc', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  const tr = (id: string): Track => ({ id, artist: `A${id}`, title: `T${id}`, bpm: 124, camelot: '8A', energy: 5, danceability: 0.7, sources: {} });

  it("an old '120min' set loads as a 120-minute journey; header shows N of ~M tracks; arc + fraction go to the server and are persisted", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: '120min', tracks: [tr('a'), tr('b')] }));
    const fetchMock = vi.fn<(u: unknown, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ suggestions: [] })));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      render(<Builder demo getSongBpmConfigured={false} />);
    });
    // no durations: each estimated 5:00, 75% played -> 2 x 3:45 = 7:30, marked estimated
    expect(screen.getByText('~7:30 of 120 min · 2 of ~32 tracks')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '120 min' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Arc shape')).toHaveValue('journey');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/suggest', expect.anything()));
    const body = () => JSON.parse(String(fetchMock.mock.calls.filter((c) => c[0] === '/api/suggest').at(-1)![1]!.body));
    expect(body()).toMatchObject({ arc: { minutes: 120, shape: 'journey' }, playFraction: 0.75 });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Played per track'), { target: { value: '0.5' } });
    });
    expect(screen.getByText('~5:00 of 120 min · 2 of ~48 tracks')).toBeInTheDocument();
    await waitFor(() => expect(body()).toMatchObject({ playFraction: 0.5 }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({ arc: { minutes: 120, shape: 'journey' }, playFraction: 0.5 }));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).not.toHaveProperty('template');
  });
});
