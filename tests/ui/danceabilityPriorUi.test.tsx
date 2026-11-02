import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import SetList from '@/components/SetList';
import { applyResolved, initialPlaylistState, playlistReducer } from '@/components/playlistReducer';
import type { Track } from '@/types/track';

const bare = (id: string, extra: Partial<Track> = {}): Track => ({ id, artist: `A ${id}`, title: `T ${id}`, sources: {}, unresolved: { reason: 'not-found', missing: ['bpm', 'camelot', 'energy', 'danceability'] }, ...extra });

describe('danceability prior on the client', () => {
  it('a MIK/manual override with bpm/key/energy completes the row with the prior', () => {
    let s = playlistReducer(initialPlaylistState, { type: 'add', track: bare('a') });
    s = playlistReducer(s, { type: 'override', id: 'a', fields: { bpm: 126, camelot: '8A', energy: 6 } });
    const t = s.tracks[0];
    expect(t.danceability).toBe(0.75);
    expect(t.sources.danceability).toBe('estimate-prior');
    expect(t.unresolved).toBeUndefined();
  });
  it('an override never replaces a real danceability', () => {
    let s = playlistReducer(initialPlaylistState, { type: 'add', track: bare('a', { danceability: 0.3, sources: { danceability: 'reccobeats' } }) });
    s = playlistReducer(s, { type: 'override', id: 'a', fields: { bpm: 126, camelot: '8A', energy: 6 } });
    expect(s.tracks[0].danceability).toBe(0.3);
  });
  it('a later real value from the resolver replaces the prior', () => {
    const withPrior: Track = { id: 'a', artist: 'x', title: 'y', bpm: 1, camelot: '1A', energy: 6, danceability: 0.75, sources: { danceability: 'estimate-prior' } };
    const t = applyResolved(withPrior, { id: 'a', artist: 'x', title: 'y', danceability: 0.4, sources: { danceability: 'preview-analysis' } });
    expect(t.danceability).toBe(0.4);
    expect(t.sources.danceability).toBe('preview-analysis');
  });
  it('SetRow marks an estimated danceability with "est." and a tooltip', () => {
    const tracks: Track[] = [
      { id: 'p', artist: 'A', title: 'P', bpm: 124, camelot: '8A', energy: 6, danceability: 0.75, sources: { danceability: 'estimate-prior' } },
      { id: 'r', artist: 'A', title: 'R', bpm: 124, camelot: '8A', energy: 6, danceability: 0.61, sources: { danceability: 'reccobeats' } },
    ];
    render(<SetList tracks={tracks} arc={{ minutes: 60, shape: 'build' }} onRemove={() => {}} onMove={() => {}} />);
    const est = screen.getAllByText(/est\./);
    expect(est).toHaveLength(1);
    expect(est[0].closest('[title]')?.getAttribute('title')).toMatch(/estimate/i);
  });
});
