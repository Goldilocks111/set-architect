// Pure: shared by the override route and the editor. Do not import node modules here.
import type { Essential } from './completeness';

export type OverrideFields = Partial<{ bpm: number; camelot: string; energy: number; danceability: number; durationMs: number }>;
export type OverrideResult = { ok: true; fields: OverrideFields } | { ok: false; error: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const CAMELOT = /^(1[0-2]|[1-9])[AB]$/;

export function validateOverride(input: unknown): OverrideResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'fields must be an object' };
  const raw = input as Record<string, unknown>;
  const fields: OverrideFields = {};
  const bad = (f: Essential, rule: string): OverrideResult => ({ ok: false, error: `${f} must be ${rule}` });

  if (raw.bpm !== undefined) {
    if (!isNum(raw.bpm) || raw.bpm < 60 || raw.bpm > 200) return bad('bpm', 'a number from 60 to 200');
    fields.bpm = raw.bpm;
  }
  if (raw.camelot !== undefined) {
    const c = typeof raw.camelot === 'string' ? raw.camelot.trim().toUpperCase() : '';
    if (!CAMELOT.test(c)) return bad('camelot', 'a Camelot key such as 8A or 12B');
    fields.camelot = c;
  }
  if (raw.energy !== undefined) {
    if (!isNum(raw.energy) || !Number.isInteger(raw.energy) || raw.energy < 1 || raw.energy > 10) return bad('energy', 'a whole number from 1 to 10');
    fields.energy = raw.energy;
  }
  if (raw.danceability !== undefined) {
    if (!isNum(raw.danceability) || raw.danceability < 0 || raw.danceability > 1) return bad('danceability', 'a number from 0 to 1');
    fields.danceability = raw.danceability;
  }
  if (raw.durationMs !== undefined) {
    if (!isNum(raw.durationMs) || raw.durationMs < 1000 || raw.durationMs > 7_200_000) return { ok: false, error: 'durationMs must be a number from 1000 to 7200000' };
    fields.durationMs = Math.round(raw.durationMs);
  }
  if (Object.keys(fields).length === 0) return { ok: false, error: 'provide at least one of bpm, camelot, energy, danceability, durationMs' };
  return { ok: true, fields };
}
