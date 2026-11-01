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

  it('highRatio is the share of spectral power above 5 kHz', () => {
    const sine = new Float32Array(SR * 5);
    for (let i = 0; i < sine.length; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / SR);
    const noise = new Float32Array(SR * 5);
    let seed = 9;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 16807) % 2147483647;
      noise[i] = 0.5 * ((seed / 2147483647) * 2 - 1);
    }
    expect(extractFeatures(sine, SR).highRatio).toBeLessThan(0.001);
    // white noise: power is flat up to Nyquist (11.025 kHz), so ~ (11025 - 5000) / 11025
    expect(extractFeatures(noise, SR).highRatio).toBeCloseTo(6025 / 11025, 1);
  });

  it('at the same loudness, a brighter mix has more energy', () => {
    const dark = new Float32Array(SR * 5);
    const bright = new Float32Array(SR * 5);
    let seed = 13;
    for (let i = 0; i < dark.length; i++) {
      seed = (seed * 16807) % 2147483647;
      const w = (seed / 2147483647) * 2 - 1;
      dark[i] = 0.3 * Math.sin((2 * Math.PI * 100 * i) / SR);
      bright[i] = 0.3 * Math.SQRT1_2 * w * Math.sqrt(3); // white noise with the same RMS as the sine
    }
    expect(energyFrom(extractFeatures(bright, SR))).toBeGreaterThan(energyFrom(extractFeatures(dark, SR)));
  });

  it('strict 4/4 at 124 BPM is danceable, random clicks are not', () => {
    const steady = extractFeatures(clicks(grid(124, 20), 20, 0.8), SR);
    let seed = 11;
    const rnd = Array.from({ length: 42 }, () => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647) * 20;
    });
    const random = extractFeatures(clicks(rnd, 20, 0.8), SR);
    // fitted on club tracks only (all 0.5-1.0 on the reference scale), so the spread is small but the order holds
    expect(danceabilityFrom(steady, 124)).toBeGreaterThan(danceabilityFrom(random) + 0.05);
    expect(danceabilityFrom(steady, 124)).toBeGreaterThan(0.6);
    expect(danceabilityFrom(random)).toBeGreaterThanOrEqual(0);
  });
});
