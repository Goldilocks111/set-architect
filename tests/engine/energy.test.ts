import { describe, expect, it } from 'vitest';
import { energyTargetAt, scoreEnergyTransition } from '@/engine/energy';

const arc = (tpl: '60min' | '120min', n: number) =>
  Array.from({ length: n }, (_, i) => energyTargetAt(tpl, i, n));

describe('energyTargetAt 60min', () => {
  const a = arc('60min', 15);
  it('follows the rulebook template', () => {
    for (const i of [0, 1, 2]) expect(a[i]).toBeGreaterThanOrEqual(4), expect(a[i]).toBeLessThanOrEqual(5);
    for (const i of [3, 4, 5, 6]) expect(a[i]).toBeGreaterThanOrEqual(5), expect(a[i]).toBeLessThanOrEqual(6);
    for (const i of [7, 8, 9, 10]) expect(a[i]).toBeGreaterThanOrEqual(6), expect(a[i]).toBeLessThanOrEqual(8);
    for (const i of [11, 12]) expect(a[i]).toBeGreaterThanOrEqual(8), expect(a[i]).toBeLessThanOrEqual(9);
    expect(a[13]).toBe(7);
    expect(a[14]).toBe(6);
  });
  it('never opens at peak and peaks in the final third', () => {
    expect(a[0]).toBeLessThan(7);
    expect(a.indexOf(Math.max(...a))).toBeGreaterThanOrEqual(10);
  });
  it('scales to other planned lengths and clamps', () => {
    expect(energyTargetAt('60min', 0, 8)).toBeLessThanOrEqual(5);
    expect(energyTargetAt('60min', 99, 15)).toBe(6);
    expect(energyTargetAt('60min', -3, 15)).toBe(4);
  });
});

describe('energyTargetAt 120min', () => {
  const a = arc('120min', 30);
  it('has warmup, first peak, reset, second higher peak, cooldown', () => {
    expect(a[0]).toBeLessThanOrEqual(4);
    const first = Math.max(...a.slice(17, 21)); // ~70-85'
    expect(first).toBeGreaterThanOrEqual(8);
    expect(first).toBeLessThanOrEqual(9);
    const reset = Math.min(...a.slice(21, 24));
    expect(reset).toBeLessThanOrEqual(7);
    expect(reset).toBeGreaterThanOrEqual(6);
    expect(Math.max(...a.slice(24, 28))).toBe(10);
    expect(a[29]).toBeLessThanOrEqual(7);
    expect(a[29]).toBeGreaterThanOrEqual(5);
  });
});

describe('scoreEnergyTransition', () => {
  it('ΔE 0 / ±1 near target = 1.0', () => {
    expect(scoreEnergyTransition(5, 5, 5).score).toBe(1);
    expect(scoreEnergyTransition(5, 6, 6).score).toBe(1);
    expect(scoreEnergyTransition(6, 5, 5).score).toBe(1);
  });
  it('+2 = 0.4 Big energy jump', () => {
    expect(scoreEnergyTransition(5, 7, 7)).toEqual({ score: 0.4, label: 'Big energy jump' });
  });
  it('unknown energy = 0.5', () => {
    expect(scoreEnergyTransition(5, undefined, 6)).toEqual({ score: 0.5, label: 'Energy unknown' });
  });
  it('moving away from target is penalized', () => {
    const toward = scoreEnergyTransition(5, 6, 7).score;
    const away = scoreEnergyTransition(7, 6, 9).score;
    expect(away).toBeLessThan(toward);
    expect(away).toBeLessThan(1);
  });
  it('reset after a peak is tolerated more than a random drop', () => {
    expect(scoreEnergyTransition(9, 6, 6).score).toBeGreaterThan(scoreEnergyTransition(6, 3, 6).score);
  });
  it('only a -2..-3 drop is a reset; bigger drops crash', () => {
    expect(scoreEnergyTransition(9, 6, 6).label).toBe('Energy reset');
    expect(scoreEnergyTransition(9, 4, 4)).toEqual({ score: 0.1, label: 'Energy crash' });
  });
  it('no previous track scores on target distance alone', () => {
    expect(scoreEnergyTransition(undefined, 4, 4).score).toBe(1);
    expect(scoreEnergyTransition(undefined, 9, 4).score).toBeLessThan(0.5);
  });
});
