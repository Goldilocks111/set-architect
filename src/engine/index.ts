// Public engine surface. Signatures are frozen; internals live in the sibling modules.
export { scoreKeyTransition } from './camelot';
export { scoreBpmTransition } from './bpm';
export { energyTargetAt, scoreEnergyTransition } from './energy';
export { DEFAULT_WEIGHTS, suggestNext } from './suggest';
