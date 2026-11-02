import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import SuggestionBox from '@/components/SuggestionBox';
import { radioPick, RADIO_COUNTDOWN_S } from '@/components/RadioControl';
import type { Suggestion, Track } from '@/types/track';

const t = (id: string, extra: Partial<Track> = {}): Track => ({ id, artist: `A ${id}`, title: `T ${id}`, sources: {}, ...extra });
const sug = (id: string, extra: Partial<Suggestion> & { compliant?: boolean } = {}): Suggestion => ({ track: t(id), score: 0.8, reasons: [], ...extra });

let respond: (playlist: Track[]) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
let added: string[];
const ok = (s: Suggestion[]) => new Response(JSON.stringify({ suggestions: s }));
/** next fresh track after the current set: c1, c2, … */
const chain = (playlist: Track[]) => ok([sug(`c${playlist.length}`)]);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  added = [];
  respond = chain;
  fetchMock = vi.fn(async (_u: unknown, init: RequestInit) => respond(JSON.parse(String(init.body)).playlist));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Harness({ planned = 3, busy = false }: { planned?: number; busy?: boolean }) {
  const [tracks, setTracks] = useState<Track[]>([t('a')]);
  return (
    <div>
      <button onClick={() => setTracks((p) => [...p, t('manual')])}>manual add</button>
      <input aria-label="search" />
      <SuggestionBox
        tracks={tracks}
        template="60min"
        plannedLength={planned}
        busy={busy}
        onAdd={(x) => {
          added.push(x.id);
          setTracks((p) => [...p, x]);
        }}
      />
    </div>
  );
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const radioOn = async () => {
  await tick(400); // first suggestions land
  fireEvent.click(screen.getByRole('switch', { name: /radio/i }));
  await tick(0);
};

describe('radioPick', () => {
  it('prefers the first compliant suggestion when the field is present', () => {
    expect(radioPick([sug('x', { compliant: false }), sug('y', { compliant: true }), sug('z', { compliant: true })])?.track.id).toBe('y');
  });
  it('falls back to reason labels when no suggestion carries compliant', () => {
    const clash = sug('x', { reasons: [{ kind: 'key', label: 'Clash', score: 0 }] });
    const bpm = sug('y', { reasons: [{ kind: 'bpm', label: '9 BPM (clash)', score: 0 }] });
    const jump = sug('j', { reasons: [{ kind: 'energy', label: 'Big energy jump', score: 0.1 }] });
    const good = sug('g', { reasons: [{ kind: 'key', label: 'Perfect match', score: 1 }] });
    expect(radioPick([clash, bpm, jump, good])?.track.id).toBe('g');
    expect(radioPick([clash, bpm])).toBeUndefined();
    expect(radioPick([])).toBeUndefined();
  });
});

describe('Radio mode', () => {
  it('is off by default: nothing is added on its own', async () => {
    render(<Harness />);
    await tick(10_000);
    expect(added).toEqual([]);
  });

  it('shows a polite, cancelable countdown and adds the pick after 4 s', async () => {
    render(<Harness planned={5} />);
    await radioOn();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.textContent).toMatch(/Adding T c1 in 4/);
    await tick(1000);
    expect(status.textContent).toMatch(/in 3/);
    await tick(2900);
    expect(added).toEqual([]);
    await tick(200);
    expect(added).toEqual(['c1']);
    expect(RADIO_COUNTDOWN_S).toBe(4);
  });

  it('chains adds after each refresh and stops at the planned length', async () => {
    render(<Harness planned={3} />);
    await radioOn();
    await tick(4_200);
    await tick(600); // refresh lands, next countdown starts
    expect(screen.getByRole('status').textContent).toMatch(/Adding T c2/);
    await tick(4_200);
    expect(added).toEqual(['c1', 'c2']);
    await tick(10_000);
    expect(added).toEqual(['c1', 'c2']);
    expect(screen.getByRole('switch', { name: /radio/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('Cancel stops the countdown and turns radio off', async () => {
    render(<Harness planned={5} />);
    await radioOn();
    await tick(1500);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await tick(10_000);
    expect(added).toEqual([]);
    expect(screen.getByRole('switch', { name: /radio/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('stops when the user adds a track themselves', async () => {
    render(<Harness planned={5} />);
    await radioOn();
    await tick(1000);
    fireEvent.click(screen.getByText('manual add'));
    await tick(10_000);
    expect(added).toEqual([]);
    expect(screen.getByRole('switch', { name: /radio/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('stops when the user interacts with search', async () => {
    render(<Harness planned={5} />);
    await radioOn();
    await tick(1000);
    fireEvent.keyDown(screen.getByLabelText('search'), { key: 'a' });
    await tick(10_000);
    expect(added).toEqual([]);
    expect(screen.getByRole('switch', { name: /radio/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('stops on a suggest error', async () => {
    render(<Harness planned={5} />);
    await radioOn();
    await tick(4_200);
    respond = () => new Response('{}', { status: 500 });
    await tick(10_000);
    expect(added).toEqual(['c1']);
    expect(screen.getByRole('switch', { name: /radio/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('stops when there is no compliant suggestion', async () => {
    respond = () => ok([sug('x', { reasons: [{ kind: 'key', label: 'Clash', score: 0 }] })]);
    render(<Harness planned={5} />);
    await tick(400);
    fireEvent.click(screen.getByRole('switch', { name: /radio/i }));
    await tick(10_000);
    expect(added).toEqual([]);
    expect(screen.getByRole('switch', { name: /radio/i })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/no compliant/i)).toBeInTheDocument();
  });

  it('stops when the same track is proposed twice', async () => {
    respond = () => ok([sug('dup')]);
    render(<Harness planned={6} />);
    await radioOn();
    await tick(4_200);
    await tick(10_000);
    expect(added).toEqual(['dup']);
    expect(screen.getByRole('switch', { name: /radio/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('waits while the add queue is busy (no parallel adds)', async () => {
    const { rerender } = render(<Harness planned={5} busy />);
    await radioOn();
    await tick(10_000);
    expect(added).toEqual([]);
    rerender(<Harness planned={5} busy={false} />);
    await tick(4_200);
    expect(added).toEqual(['c1']);
  });
});
