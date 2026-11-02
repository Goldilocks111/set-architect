// Wave-0 sanity: frozen contracts compile and demo data is well-formed.
import { describe, expect, it } from 'vitest';
import { trackKeyOf } from '@/types/track';
import { demoTracks, searchDemoTracks } from '@/lib/demo';
import { DEFAULT_WEIGHTS, suggestNext } from '@/engine';

describe('frozen contracts', () => {
  it('demo seed loads with valid fields', () => {
    const tracks = demoTracks();
    expect(tracks.length).toBeGreaterThanOrEqual(50);
    for (const t of tracks) {
      expect(t.id).toMatch(/^demo-/);
      expect(t.bpm).toBeGreaterThan(90);
      expect(t.camelot).toMatch(/^([1-9]|1[0-2])[AB]$/);
      expect(t.energy).toBeGreaterThanOrEqual(1);
      expect(t.energy).toBeLessThanOrEqual(10);
      expect(t.sources.bpm).toBe('demo-seed');
    }
  });

  it('seed ids are unique', () => {
    const ids = demoTracks().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('search filters by artist and title', () => {
    expect(searchDemoTracks('fred again').length).toBeGreaterThanOrEqual(3);
    expect(searchDemoTracks('zzzz-nothing')).toHaveLength(0);
  });

  it('trackKeyOf normalizes punctuation, case and mix suffixes', () => {
    expect(trackKeyOf('Fred again..', 'Rumble')).toBe(trackKeyOf('fred again', 'RUMBLE'));
    expect(trackKeyOf('CamelPhat', 'Cola (Original Mix)')).toBe(trackKeyOf('camelphat', 'cola'));
  });

  it('suggestNext returns compliance-tiered suggestions with reasons, excluding set tracks', () => {
    const tracks = demoTracks();
    const out = suggestNext({
      playlist: tracks.slice(0, 3),
      candidates: tracks,
      arc: { minutes: 60, shape: 'build' },
      weights: DEFAULT_WEIGHTS,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(10);
    const ids = new Set(out.map((s) => s.track.id));
    expect(ids.has(tracks[0].id)).toBe(false);
    // Sorted compliant-first (criterion 3), then by score within each tier.
    for (let i = 1; i < out.length; i++) {
      const [a, b] = [out[i - 1], out[i]];
      expect(Number(a.compliant)).toBeGreaterThanOrEqual(Number(b.compliant));
      if (a.compliant === b.compliant) expect(a.score).toBeGreaterThanOrEqual(b.score);
    }
    expect(out[0].reasons.map((r) => r.kind)).toContain('key');
  });
});
