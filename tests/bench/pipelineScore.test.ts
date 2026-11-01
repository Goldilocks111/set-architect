import { describe, expect, it } from 'vitest';
import { PIPELINE_LIMIT_MS, pipelinePass, summarizePipeline, type PipelineRow } from '../../bench/data/score';

const row = (over: Partial<PipelineRow>): PipelineRow => ({
  id: 'a',
  bucket: 'classic',
  state: 'complete',
  missing: [],
  elapsedMs: 1000,
  pass: true,
  ...over,
});

describe('pipelinePass', () => {
  it('passes a complete track within the limit', () => {
    expect(pipelinePass({ state: 'complete', elapsedMs: 1000 })).toBe(true);
  });
  it('passes an incomplete track that states a reason', () => {
    expect(pipelinePass({ state: 'incomplete', reason: 'not-found', elapsedMs: 5000 })).toBe(true);
  });
  it('fails an incomplete track without a reason (silent gap)', () => {
    expect(pipelinePass({ state: 'incomplete', elapsedMs: 5000 })).toBe(false);
  });
  it('fails anything over 60s, passes exactly 60s', () => {
    expect(pipelinePass({ state: 'complete', elapsedMs: PIPELINE_LIMIT_MS })).toBe(true);
    expect(pipelinePass({ state: 'complete', elapsedMs: PIPELINE_LIMIT_MS + 1 })).toBe(false);
    expect(pipelinePass({ state: 'incomplete', reason: 'timeout', elapsedMs: 61_000 })).toBe(false);
  });
});

describe('summarizePipeline', () => {
  const rows: PipelineRow[] = [
    row({ id: '1', bucket: 'classic', elapsedMs: 100 }),
    row({ id: '2', bucket: 'classic', state: 'incomplete', reason: 'not-found', missing: ['bpm'], elapsedMs: 200 }),
    row({ id: '3', bucket: 'recent', state: 'incomplete', reason: 'not-found', missing: ['energy'], elapsedMs: 300 }),
    row({ id: '4', bucket: 'recent', elapsedMs: 400, pass: false }),
  ];
  it('counts passes and complete fractions per bucket', () => {
    const s = summarizePipeline(rows);
    expect(s.n).toBe(4);
    expect(s.passed).toBe(3);
    expect(s.complete).toEqual({ all: 0.5, classic: 0.5, recent: 0.5 });
  });
  it('builds a reasons histogram over incomplete tracks only', () => {
    expect(summarizePipeline(rows).reasons).toEqual({ 'not-found': 2 });
  });
  it('reports elapsed percentiles', () => {
    const s = summarizePipeline(rows);
    expect(s.p50).toBe(200);
    expect(s.p95).toBe(400);
  });
  it('handles no rows', () => {
    const s = summarizePipeline([]);
    expect(s.n).toBe(0);
    expect(s.complete.all).toBe(0);
  });
});
