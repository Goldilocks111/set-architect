import { describe, expect, it } from 'vitest';
import { toTrack } from '@/components/SpotifyImport';

describe('SpotifyImport toTrack', () => {
  const t = { artist: 'A', title: 'T', spotifyId: 'x', durationMs: 391000 };
  it('carries durationMs with source spotify (single add and Add all/crate share this mapping)', () => {
    const out = toTrack(t);
    expect(out.durationMs).toBe(391000);
    expect(out.sources.durationMs).toBe('spotify');
    expect([t, { ...t, spotifyId: 'y' }].map(toTrack).every((x) => x.durationMs === 391000)).toBe(true);
  });
  it('omits it when Spotify gave none', () => {
    const out = toTrack({ ...t, durationMs: undefined });
    expect(out).not.toHaveProperty('sources.durationMs');
    expect(out.sources.durationMs).toBeUndefined();
  });
});
