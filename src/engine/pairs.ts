import type { Track } from '@/types/track';
import { isEnergyBoostKey, parseCamelot } from './camelot';
import { isKeyCompatible, isTempoCompatible } from './compliance';

export type PairIssue = { kind: 'key' | 'tempo' | 'energy'; label: string };
export type PairStatus = 'ok' | 'bad' | 'unknown';

const num = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** Per-rule verdict for a literal neighbour pair. A rule whose inputs are missing on either side is 'unknown'. */
export function pairCheck(from: Track, to: Track): { key: PairStatus; tempo: PairStatus; energy: PairStatus; issues: PairIssue[] } {
  const issues: PairIssue[] = [];

  let key: PairStatus = 'unknown';
  if (parseCamelot(from.camelot) && parseCamelot(to.camelot)) {
    key = isKeyCompatible(from.camelot, to.camelot) ? 'ok' : 'bad';
    if (key === 'bad') issues.push({ kind: 'key', label: `Key clash ${from.camelot}→${to.camelot}` });
  }

  let tempo: PairStatus = 'unknown';
  if (num(from.bpm) && from.bpm > 0 && num(to.bpm) && to.bpm > 0) {
    tempo = isTempoCompatible(from.bpm, to.bpm) ? 'ok' : 'bad';
    if (tempo === 'bad') issues.push({ kind: 'tempo', label: `Tempo clash ${fmt(from.bpm)}→${fmt(to.bpm)} BPM` });
  }

  let energy: PairStatus = 'unknown';
  if (num(from.energy) && num(to.energy)) {
    const d = to.energy - from.energy;
    const keysKnown = !!parseCamelot(from.camelot) && !!parseCamelot(to.camelot);
    const boost = keysKnown && isEnergyBoostKey(from.camelot!, to.camelot!);
    energy = 'ok';
    // +2 is fine only on a Camelot +2 boost: with a key unknown that can't be checked either way
    if (d >= 2 && d < 3 && !keysKnown) energy = 'unknown';
    else if (d >= 3 || (d >= 2 && !boost)) {
      energy = 'bad';
      issues.push({ kind: 'energy', label: `Energy jump ${fmt(from.energy)}→${fmt(to.energy)}` });
    } else if (d <= -4) {
      energy = 'bad';
      issues.push({ kind: 'energy', label: `Energy crash ${fmt(from.energy)}→${fmt(to.energy)}` });
    }
  }

  return { key, tempo, energy, issues };
}

/** Adjacent pairs that break the key/tempo/energy rules (arc-independent). `index` is the incoming track's position. */
export function pairViolations(tracks: Track[]): Array<{ index: number; issues: PairIssue[] }> {
  const out: Array<{ index: number; issues: PairIssue[] }> = [];
  for (let i = 1; i < tracks.length; i++) {
    const { issues } = pairCheck(tracks[i - 1], tracks[i]);
    if (issues.length) out.push({ index: i, issues });
  }
  return out;
}
