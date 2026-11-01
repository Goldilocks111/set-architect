import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateBpm, foldBpm, analysePreview, analyseFull, analysePcm } from '@/lib/analysis/previewAnalysis';
import { mockFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

/** Mono click track: short decaying noise bursts on every beat. */
function clickTrack(bpm: number, seconds: number, sr = 22050): Float32Array {
  const pcm = new Float32Array(sr * seconds);
  const step = (60 / bpm) * sr;
  let seed = 1;
  for (let b = 0; b * step < pcm.length; b++) {
    const start = Math.round(b * step);
    for (let i = 0; i < 1500 && start + i < pcm.length; i++) {
      seed = (seed * 16807) % 2147483647;
      pcm[start + i] = ((seed / 2147483647) * 2 - 1) * Math.exp(-i / 300);
    }
  }
  return pcm;
}

describe('previewAnalysis', () => {
  it('estimates the tempo of a synthetic click track', () => {
    const bpm = estimateBpm(clickTrack(120, 30), 22050);
    expect(bpm).toBeDefined();
    expect(Math.abs(bpm! - 120)).toBeLessThan(3);
  });

  it('returns undefined for silence and for too-short audio', () => {
    expect(estimateBpm(new Float32Array(22050 * 30), 22050)).toBeUndefined();
    expect(estimateBpm(new Float32Array(1000), 22050)).toBeUndefined();
  });

  it('folds octave errors into the DJ range', () => {
    expect(foldBpm(240)).toBe(120);
    expect(foldBpm(60)).toBe(120);
    expect(foldBpm(128)).toBe(128);
  });

  it('never throws: undecodable bytes give {}', async () => {
    mockFetch([['preview.test', () => new Response(new Uint8Array([1, 2, 3, 4]))]]);
    expect(await analysePreview('nobody|nothing-test', 'https://preview.test/x.mp3')).toEqual({});
  });
});

describe('analyseFull / analysePcm', () => {
  const tone = (hz: number, seconds: number, sr = 22050) =>
    Float32Array.from({ length: sr * seconds }, (_, i) => 0.4 * Math.sin((2 * Math.PI * hz * i) / sr));

  it('rejects silence and short audio', async () => {
    expect(analysePcm(new Float32Array(22050 * 30), 22050)).toBeUndefined();
    expect(analysePcm(tone(440, 3), 22050)).toBeUndefined();
    expect(await analyseFull(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });

  it('returns v2 with energy and danceability for a click track', () => {
    const a = analysePcm(clickTrack(124, 20), 22050);
    expect(a?.v).toBe(2);
    expect(a?.energy).toBeGreaterThanOrEqual(1);
    expect(a?.danceability).toBeGreaterThan(0);
  });
});
