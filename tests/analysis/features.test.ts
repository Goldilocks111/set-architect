import { describe, expect, it } from 'vitest';
import { danceabilityFrom, energyFrom, extractFeatures } from '@/lib/analysis/features';

const SR = 22050;

function clicks(times: number[], seconds: number, amp: number): Float32Array {
  const pcm = new Float32Array(SR * seconds);
  let seed = 3;
  for (const t of times) {
    const s = Math.round(t * SR);
    for (let i = 0; i < 1500 && s + i < pcm.length; i++) {
      seed = (seed * 16807) % 2147483647;
      pcm[s + i] = amp * ((seed / 2147483647) * 2 - 1) * Math.exp(-i / 300);
    }
  }
  return pcm;
}
const grid = (bpm: number, seconds: number) => Array.from({ length: Math.floor((seconds * bpm) / 60) }, (_, i) => (i * 60) / bpm);

describe('features', () => {
  it('louder + denser click track has higher energy than quiet sparse one', () => {
    const loud = extractFeatures(clicks(grid(480, 15), 15, 0.9), SR);
    const quiet = extractFeatures(clicks(grid(60, 15), 15, 0.05), SR);
    expect(energyFrom(loud)).toBeGreaterThan(energyFrom(quiet));
    expect(energyFrom(loud)).toBeLessThanOrEqual(10);
    expect(energyFrom(quiet)).toBeGreaterThanOrEqual(1);
  });

  it('strict 4/4 at 124 BPM is danceable, random clicks are not', () => {
    const steady = extractFeatures(clicks(grid(124, 20), 20, 0.8), SR);
    let seed = 11;
    const rnd = Array.from({ length: 42 }, () => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647) * 20;
    });
    const random = extractFeatures(clicks(rnd, 20, 0.8), SR);
    expect(danceabilityFrom(steady, 124)).toBeGreaterThan(0.6);
    expect(danceabilityFrom(random)).toBeLessThan(0.4);
  });
});
