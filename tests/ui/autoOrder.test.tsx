import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import Builder from '@/components/Builder';
import AutoOrderPanel from '@/components/AutoOrderPanel';
import { STORAGE_KEY } from '@/components/persistence';
import type { Track } from '@/types/track';

const tr = (id: string, camelot: string, energy = 5): Track => ({
  id, artist: `Artist ${id}`, title: `Title ${id}`, camelot, bpm: 128, energy, danceability: 0.6, durationMs: 300_000, sources: {},
});
const arc = { minutes: 60, shape: 'build' } as const;
// shuffled: 10A→8A, 8A→10B and 10B→9A all clash; 8A 9A 10A 10B is clean and its energies 4 4 5 5 sit on the
// 60-min build targets (the clean reverse order 10B 10A 9A 8A would not)
const shuffled = [tr('c', '10A', 5), tr('a', '8A', 4), tr('d', '10B', 5), tr('b', '9A', 4)];

const setOrder = () => within(screen.getByRole('list', { name: 'Set list' })).getAllByRole('listitem').map((li) => li.getAttribute('data-track-id'));

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function renderBuilder(tracks: Track[]) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ suggestions: [] })));
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ arc, tracks }));
  await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
}

describe('Suggest order → preview → Apply / Cancel → Undo', () => {
  it('previews the proposal with moved tracks and before/after counts, then applies and undoes it', async () => {
    await renderBuilder(shuffled);
    expect(setOrder()).toEqual(['c', 'a', 'd', 'b']);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest order' }));
    const dialog = screen.getByRole('dialog', { name: 'Suggested order' });
    expect(within(dialog).getByText('3 rough → 0 rough')).toBeInTheDocument();
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-track-id'))).toEqual(['a', 'b', 'c', 'd']);
    expect(rows.filter((r) => r.getAttribute('data-moved') === 'true').length).toBeGreaterThan(0);
    expect(setOrder()).toEqual(['c', 'a', 'd', 'b']); // preview only

    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(screen.queryByRole('dialog', { name: 'Suggested order' })).toBeNull();
    expect(setOrder()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.queryByRole('button', { name: /rough transition/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).orderUndo).toBeUndefined(); // undo is session-only

    fireEvent.click(screen.getByRole('button', { name: 'Undo reorder' }));
    expect(setOrder()).toEqual(['c', 'a', 'd', 'b']);
    expect(screen.queryByRole('button', { name: 'Undo reorder' })).toBeNull();
  });

  it('Cancel leaves the set untouched', async () => {
    await renderBuilder(shuffled);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest order' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Suggested order' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(setOrder()).toEqual(['c', 'a', 'd', 'b']);
    expect(screen.queryByRole('button', { name: 'Undo reorder' })).toBeNull();
  });
});

describe('<AutoOrderPanel />', () => {
  it('says so when no clash-free order exists, and still offers the fewest-violation order', () => {
    const onApply = vi.fn();
    const tracks = [tr('x', '3B'), tr('a', '8A'), tr('b', '8A')];
    render(<AutoOrderPanel tracks={tracks} arc={arc} onApply={onApply} onCancel={vi.fn()} />);
    expect(screen.getByText('1 rough → 1 rough')).toBeInTheDocument();
    expect(screen.getByText(/No order avoids every rough transition/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect([...onApply.mock.calls[0][0]].sort()).toEqual(['a', 'b', 'x']);
  });

  it('keep-first pins the current opener', () => {
    const onApply = vi.fn();
    render(<AutoOrderPanel tracks={shuffled} arc={arc} onApply={onApply} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep first track' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply.mock.calls[0][0][0]).toBe('c');
  });
});
