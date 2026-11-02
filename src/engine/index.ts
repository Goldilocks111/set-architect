// Public engine surface. Signatures are frozen; internals live in the sibling modules.
export { scoreKeyTransition } from './camelot';
export { scoreBpmTransition } from './bpm';
export {
  averagePlayedMinutes,
  energyTargetAtMinute,
  nextTrackTarget,
  plannedTrackCount,
  positionMinutes,
  scoreEnergyTransition,
  setPlayedMinutes,
  slotMidMinutes,
  startMinutes,
  trackTargets,
} from './energy';
export { DEFAULT_WEIGHTS, suggestNext } from './suggest';
export { pairCheck, pairViolations } from './pairs';
export type { PairIssue, PairStatus } from './pairs';
export { autoOrder, orderCost } from './autoOrder';
export type { AutoOrderOptions, AutoOrderResult } from './autoOrder';
