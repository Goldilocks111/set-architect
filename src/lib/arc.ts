import type { Arc, ArcShape } from '@/types/track';

export const ARC_SHAPES: readonly ArcShape[] = ['build', 'journey', 'warm-up', 'peak-time'];
export const ARC_PRESETS = [30, 60, 90, 120, 180, 240] as const;
export const ARC_MIN_MINUTES = 15;
export const ARC_MAX_MINUTES = 480;
export const DEFAULT_ARC: Arc = { minutes: 60, shape: 'build' };

/** Share of each track actually played before the next one is mixed in. */
export const DEFAULT_PLAY_FRACTION = 0.75;
export const PLAY_FRACTION_MIN = 0.5;
export const PLAY_FRACTION_MAX = 1;

/** The two old track-count templates, as minute arcs. */
const LEGACY: Record<string, Arc> = {
  '60min': { minutes: 60, shape: 'build' },
  '120min': { minutes: 120, shape: 'journey' },
};

const isShape = (v: unknown): v is ArcShape => (ARC_SHAPES as readonly unknown[]).includes(v);

const clampMinutes = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(ARC_MAX_MINUTES, Math.max(ARC_MIN_MINUTES, Math.round(v)))
    : null;

/**
 * Any stored or sent arc -> a valid Arc: an `{ minutes, shape }` object, the text-column form "90min:journey",
 * or a legacy template ('60min' / '120min'). Bad fields fall back one at a time; anything else is the default.
 */
export function toArc(v: unknown): Arc {
  if (typeof v === 'string') {
    if (LEGACY[v]) return { ...LEGACY[v] };
    const m = /^(\d{1,4})min:([a-z-]+)$/.exec(v);
    if (m && isShape(m[2])) return { minutes: clampMinutes(Number(m[1]))!, shape: m[2] };
    return { ...DEFAULT_ARC };
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return {
      minutes: clampMinutes(o.minutes) ?? DEFAULT_ARC.minutes,
      shape: isShape(o.shape) ? o.shape : DEFAULT_ARC.shape,
    };
  }
  return { ...DEFAULT_ARC };
}

/** Text form for the saved-set `arc_template` column (no schema change; legacy values still read via toArc). */
export const encodeArc = (a: Arc): string => `${a.minutes}min:${a.shape}`;

export const SHAPE_LABELS: Record<ArcShape, string> = {
  build: 'build',
  journey: 'journey',
  'warm-up': 'warm-up',
  'peak-time': 'peak time',
};

export const arcLabel = (a: Arc): string => `${a.minutes} min ${SHAPE_LABELS[a.shape]}`;

/** The arc fields of a request body; a legacy `template` ('60min' / '120min') still maps. */
export function arcInput(body: { arc?: unknown; template?: unknown; playFraction?: unknown }): { arc: Arc; playFraction: number } {
  return { arc: toArc(body.arc ?? body.template), playFraction: clampPlayFraction(body.playFraction) };
}

export function clampPlayFraction(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_PLAY_FRACTION;
  return Math.min(PLAY_FRACTION_MAX, Math.max(PLAY_FRACTION_MIN, v));
}
