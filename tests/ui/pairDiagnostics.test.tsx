import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import Builder from '@/components/Builder';
import SetList from '@/components/SetList';
import { transitionParts } from '@/components/TransitionBadge';
import { pairCheck } from '@/engine';
import { STORAGE_KEY } from '@/components/persistence';
import type { Track } from '@/types/track';

const tr = (id: string, camelot?: string, bpm?: number, energy?: number): Track => ({
  id, artist: `A${id}`, title: `T${id}`, camelot, bpm, energy, sources: {},
});
const arc = { minutes: 60, shape: 'build' } as const;
const noop = vi.fn();
const view = (tracks: Track[]) =>
  render(<SetList tracks={tracks} arc={arc} onRemove={noop} onMove={noop} />);

describe('pair diagnostics in SetList', () => {
  it('flags a violating transition with warning text', () => {
    const { container } = view([tr('a', '8A', 128, 5), tr('b', '3B', 128, 5)]);
    expect(screen.getByText(/Key clash 8A→3B/)).toBeTruthy();
    expect(container.querySelector('#transition-b')?.getAttribute('data-violation')).toBe('true');
  });
  it('does not flag a clean or unknown transition', () => {
    const { container } = view([tr('a', '8A', 128, 5), tr('b', '9A', 128, 6), tr('c')]);
    expect(container.querySelector('[data-violation]')).toBeNull();
    expect(screen.queryByText(/⚠/)).toBeNull();
  });
});

describe('tempo at exactly the ±6% boundary', () => {
  it('tooltip detail and violation flag agree (both from isTempoCompatible)', () => {
    for (const [from, to] of [[100, 106], [100, 94], [128, 135.68], [100, 212], [100, 47]] as const) {
      const a = tr('a', '8A', from, 5);
      const b = tr('b', '8A', to, 5);
      const tempo = transitionParts({ from: a, to: b, target: 5 }).find((p) => p.name === 'Tempo')!;
      expect(pairCheck(a, b).tempo, `${from}→${to}`).toBe('ok');
      expect(tempo.detail, `${from}→${to}`).not.toBe('Tempo clash');
    }
    const a = tr('a', '8A', 100, 5);
    const b = tr('b', '8A', 106.1, 5);
    expect(pairCheck(a, b).tempo).toBe('bad');
    expect(transitionParts({ from: a, to: b, target: 5 }).find((p) => p.name === 'Tempo')!.detail).toBe('Tempo clash');
  });
});

describe('header "N rough transitions" button', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });
  it('scrolls to and focuses the first flagged transition', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ suggestions: [] })));
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    onTestFinished(() => { Element.prototype.scrollIntoView = original; });
    const d = 0.6;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      arc: { minutes: 60, shape: 'build' },
      tracks: [
        { ...tr('a', '8A', 128, 5), danceability: d },
        { ...tr('b', '8A', 128, 5), danceability: d },
        { ...tr('c', '3B', 128, 5), danceability: d },
        { ...tr('e', '3B', 90, 5), danceability: d },
      ],
    }));
    await act(async () => { render(<Builder demo getSongBpmConfigured={false} />); });
    fireEvent.click(screen.getByRole('button', { name: '2 rough transitions' }));
    const first = document.getElementById('transition-c')!;
    expect(scroll.mock.contexts[0]).toBe(first);
    expect(document.activeElement).toBe(first);
  });
});
