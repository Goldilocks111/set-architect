import { describe, expect, it } from 'vitest';
import { scoreBpmTransition } from '@/engine/bpm';

describe('scoreBpmTransition', () => {
  it('identical = 1.0 direct', () => {
    expect(scoreBpmTransition(128, 128)).toEqual({ score: 1, relation: 'direct' });
  });
  it('+3% is roughly the linear midpoint', () => {
    const r = scoreBpmTransition(128, 131.8);
    expect(r.relation).toBe('direct');
    expect(r.score).toBeCloseTo(0.5, 1);
  });
  it('+6% and beyond = 0 clash', () => {
    expect(scoreBpmTransition(128, 135.7)).toEqual({ score: 0, relation: 'clash' });
    expect(scoreBpmTransition(128, 150)).toEqual({ score: 0, relation: 'clash' });
  });
  it('double-time scores 0.9 × direct-equivalent', () => {
    const r = scoreBpmTransition(86, 172);
    expect(r.relation).toBe('double-time');
    expect(r.score).toBeCloseTo(0.9, 5);
  });
  it('half-time', () => {
    const r = scoreBpmTransition(174, 87);
    expect(r.relation).toBe('half-time');
    expect(r.score).toBeCloseTo(0.9, 5);
  });
  it('prefers direct over half/double when direct is as good', () => {
    expect(scoreBpmTransition(128, 128).relation).toBe('direct');
  });
  it('invalid input is a clash', () => {
    expect(scoreBpmTransition(0, 120)).toEqual({ score: 0, relation: 'clash' });
  });
});
