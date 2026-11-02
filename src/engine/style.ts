import type { Track } from '@/types/track';
import { LANES, type Lane } from '@/lib/style/taxonomy';
import { isComplete } from '@/lib/completeness';

/** Most recent first: the set's lane follows what is playing now, not the opener. */
const RECENCY = [1, 0.8, 0.6, 0.4, 0.2];
/** A track's lanes are ordered by tag weight. */
const RANK = [1, 0.6, 0.3];
const SAME_LANE = 0.6;
const LANE_CHANGE = 0.2;

const LANE_SET = new Set<string>(LANES);

function laneVector(t: Track): Map<Lane, number> {
  const v = new Map<Lane, number>();
  (t.styles ?? [])
    .filter((s): s is Lane => LANE_SET.has(s))
    .slice(0, RANK.length)
    .forEach((lane, i) => v.set(lane, Math.max(v.get(lane) ?? 0, RANK[i])));
  return v;
}

/** Lane weights of the last 5 complete tracks, recency-weighted. */
export function laneProfile(recent: Track[]): Map<Lane, number> {
  const profile = new Map<Lane, number>();
  recent
    .filter(isComplete)
    .slice(-RECENCY.length)
    .reverse()
    .forEach((t, i) => {
      for (const [lane, w] of laneVector(t)) profile.set(lane, (profile.get(lane) ?? 0) + RECENCY[i] * w);
    });
  return profile;
}

const laneName = (lane: Lane) => lane.replace(/-/g, ' ');

/** Cosine of the set's lane profile and the candidate's lanes; undefined (neutral) when either side has none. */
export function styleScore(profile: Map<Lane, number>, t: Track): { score: number; label?: string } | undefined {
  const cand = laneVector(t);
  if (!profile.size || !cand.size) return undefined;
  let dot = 0;
  let shared: Lane | undefined;
  let best = 0;
  for (const [lane, w] of cand) {
    const p = profile.get(lane) ?? 0;
    dot += p * w;
    if (p * w > best) [best, shared] = [p * w, lane];
  }
  const norm = (v: Iterable<number>) => Math.sqrt([...v].reduce((a, x) => a + x * x, 0));
  const score = Math.min(1, dot / (norm(profile.values()) * norm(cand.values())));
  if (score >= SAME_LANE && shared) return { score, label: `Same lane: ${laneName(shared)}` };
  if (score <= LANE_CHANGE) return { score, label: 'Lane change' };
  return { score };
}
