/** Shared layout of ~/.setarchitect/bench/u2-features.json (derived numbers only, never audio). */
export const MIDI_LO = 33; // A1, 55 Hz
export const MIDI_HI = 107; // B7, ~3951 Hz
export const SUB = 5; // pitch bins per semitone (20 cents)
export const NBINS = (MIDI_HI - MIDI_LO + 1) * SUB;

export type SpecName = 'box4096' | 'fir4096' | 'fir8192';

export interface TrackFeatures {
  deezerId: number;
  deezerTitle: string;
  sampleRate: number;
  rate: number;
  /** The analyser shipped at extraction time on the same audio (checks we fetched what the bench analysed). */
  baseline: {
    camelot?: string;
    keyConfidence?: number;
    bpm?: number;
    features?: { rmsDb: number; onsetRate: number; centroidHz: number; pulseClarity: number };
  };
  tuningCents: number;
  extras: { flatness: number; lowRatio: number; highRatio: number; loudnessRange: number };
  /** frames x NBINS Float32 magnitudes, base64. */
  spec: Record<SpecName, { frames: number; b64: string }>;
}

export interface FeatureFile {
  tracks: Record<string, TrackFeatures>;
}

export function decodeSpec(s: { frames: number; b64: string }): Float32Array[] {
  const buf = Buffer.from(s.b64, 'base64');
  const all = new Float32Array(new Uint8Array(buf).buffer); // copy: Buffer offsets need not be 4-aligned
  return Array.from({ length: s.frames }, (_, f) => all.subarray(f * NBINS, (f + 1) * NBINS));
}
