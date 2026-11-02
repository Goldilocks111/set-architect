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
    expect(steady.pulseClarity).toBeGreaterThan(random.pulseClarity + 0.2);
    expect(danceabilityFrom(steady)).toBeGreaterThan(danceabilityFrom(random)); // pulse-clarity term alone
    expect(danceabilityFrom(random)).toBeGreaterThanOrEqual(0.6); // the fitted scale sits near the club-track mean
    expect(danceabilityFrom(random)).toBeLessThanOrEqual(0.72);
  });

  it('a club tempo (95-150 BPM) adds about 0.04, other tempos add nothing', () => {
    const f = extractFeatures(clicks(grid(124, 20), 20, 0.8), SR);
    const bonus = danceabilityFrom(f, 124) - danceabilityFrom(f);
    expect(bonus).toBeGreaterThanOrEqual(0.03);
    expect(bonus).toBeLessThanOrEqual(0.06);
    expect(danceabilityFrom(f, 180)).toBe(danceabilityFrom(f));
    expect(danceabilityFrom(f, 80)).toBe(danceabilityFrom(f));
  });

  it('danceability is clamped to 0..1', () => {
    const f = extractFeatures(clicks(grid(124, 20), 20, 0.8), SR);
    expect(danceabilityFrom({ ...f, pulseClarity: 100 }, 124)).toBe(1);
    expect(danceabilityFrom({ ...f, pulseClarity: -100 })).toBe(0);
  });
});
