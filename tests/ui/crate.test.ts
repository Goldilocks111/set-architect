import { beforeEach, describe, expect, it } from 'vitest';
import { addToCrate, clearCrate, mergeCrateKnown, CRATE_KEY, CRATE_MAX, CRATE_SEND_MAX, crateForRequest, loadCrate, removeFromCrate, type CrateTrack } from '@/components/crate';
import type { Track } from '@/types/track';

const full = { bpm: 124, camelot: '8A', energy: 6, danceability: 0.7 };
const t = (n: number, extra: Partial<Track> = {}): Track => ({ id: `t${n}`, artist: `Artist ${n}`, title: `Song ${n}`, sources: {}, ...extra });
const item = (n: number, addedAt: number, extra: Partial<CrateTrack> = {}): CrateTrack => ({
  id: `t${n}`,
  artist: `Artist ${n}`,
  title: `Song ${n}`,
  addedAt,
  from: 'spotify',
  ...extra,
});

beforeEach(() => window.localStorage.clear());

describe('crate storage', () => {
  it('stores tracks under the versioned key and loads them back', () => {
    addToCrate([t(1, full)], 'set');
    expect(window.localStorage.getItem(CRATE_KEY)).toBeTruthy();
    expect(loadCrate()).toMatchObject([{ id: 't1', artist: 'Artist 1', from: 'set', ...full }]);
  });

  it('loads an empty crate from blocked, missing or corrupt storage', () => {
    expect(loadCrate()).toEqual([]);
    window.localStorage.setItem(CRATE_KEY, '{nope');
    expect(loadCrate()).toEqual([]);
  });

  it('keeps only crate fields (no previews, sources or other provider data)', () => {
    addToCrate([t(1, { ...full, previewUrl: 'https://x/y.mp3', spotifyId: 'a'.repeat(22), sources: { bpm: 'x' } })], 'set');
    const [c] = loadCrate();
    expect(Object.keys(c).sort()).toEqual(['addedAt', 'artist', 'bpm', 'camelot', 'danceability', 'energy', 'from', 'id', 'title']);
  });

  it('dedupes by artist/title key, newest wins and keeps what the older copy knew', () => {
    addToCrate([t(1, full)], 'mik');
    const after = addToCrate([{ ...t(1), id: 'other-id', title: 'Song 1 (Extended Mix)' }, t(2)], 'spotify');
    // "(Extended Mix)" is the same recording for the key; the newer id/from win, the known bpm survives
    expect(after.filter((c) => c.artist === 'Artist 1')).toHaveLength(1);
    const one = after.find((c) => c.artist === 'Artist 1')!;
    expect(one).toMatchObject({ id: 'other-id', from: 'spotify', bpm: 124 });
    expect(after).toHaveLength(2);
  });

  it('caps at CRATE_MAX, dropping the oldest', () => {
    const many = Array.from({ length: CRATE_MAX + 5 }, (_, i) => t(i));
    const after = addToCrate(many, 'spotify');
    expect(after).toHaveLength(CRATE_MAX);
    expect(after.some((c) => c.id === 't0')).toBe(false);
    expect(after.some((c) => c.id === `t${CRATE_MAX + 4}`)).toBe(true);
    // re-adding an old one makes it newest, so a later overflow drops somebody else
    const again = addToCrate([t(5)], 'search');
    expect(again).toHaveLength(CRATE_MAX);
    expect(again[again.length - 1].id).toBe('t5');
  });

  it('removes one track and clears all', () => {
    addToCrate([t(1), t(2)], 'set');
    expect(removeFromCrate('t1').map((c) => c.id)).toEqual(['t2']);
    expect(loadCrate().map((c) => c.id)).toEqual(['t2']);
    expect(clearCrate()).toEqual([]);
    expect(loadCrate()).toEqual([]);
  });
});

describe('crateForRequest', () => {
  it('excludes tracks already in the set (by id or artist/title)', () => {
    const crate = [item(1, 1, full), item(2, 2, full), item(3, 3, full)];
    const out = crateForRequest(crate, [t(1), { ...t(9), artist: 'Artist 3', title: 'Song 3' }]);
    expect(out.map((c) => c.id)).toEqual(['t2']);
  });

  it('puts complete tracks first, then most recent first within each group', () => {
    const crate = [item(1, 10, full), item(2, 50), item(3, 20, full), item(4, 40), item(5, 30, full)];
    expect(crateForRequest(crate, []).map((c) => c.id)).toEqual(['t5', 't3', 't1', 't2', 't4']);
  });

  it('is capped at CRATE_SEND_MAX, keeping the complete and the recent', () => {
    const crate = [
      ...Array.from({ length: CRATE_SEND_MAX }, (_, i) => item(i, 1000 + i)), // incomplete, newer
      item(9001, 1, full), // complete but oldest: must still make it
    ];
    const out = crateForRequest(crate, []);
    expect(out).toHaveLength(CRATE_SEND_MAX);
    expect(out[0].id).toBe('t9001');
  });
});

describe('mergeCrateKnown', () => {
  const k = { key: 'artist 1|song 1', bpm: 128, camelot: '9A', energy: 7, danceability: 0.8 };

  it('folds the server-known values into the stored crate; cache values win', () => {
    addToCrate([t(1, { bpm: 100 }), t(2)], 'spotify');
    const next = mergeCrateKnown([k]);
    expect(next.find((c) => c.id === 't1')).toMatchObject({ bpm: 128, camelot: '9A', energy: 7, danceability: 0.8 });
    expect(loadCrate().find((c) => c.id === 't1')).toMatchObject({ bpm: 128 });
    expect(next.find((c) => c.id === 't2')!.bpm).toBeUndefined();
  });

  it('returns the very same array when nothing changes (no re-render, no refresh loop)', () => {
    addToCrate([t(1)], 'spotify');
    const once = mergeCrateKnown([k]);
    expect(mergeCrateKnown([k], once)).toBe(once);
    expect(mergeCrateKnown([], once)).toBe(once);
  });

  it('makes server-known items count as complete for request ordering', () => {
    addToCrate([t(1), t(2, full)], 'spotify');
    const next = mergeCrateKnown([k]);
    expect(crateForRequest(next, []).map((c) => c.id).sort()).toEqual(['t1', 't2']);
  });
});
