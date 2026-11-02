import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import SetList from '@/components/SetList';
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
