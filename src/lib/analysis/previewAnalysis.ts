import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from '@/lib/dataDir';
import { MPEGDecoder } from 'mpg123-decoder';
import MusicTempo from 'music-tempo';
import { fetchWithTimeout } from '../http';
import type { Track } from '@/types/track';
import { dropStaleKeys, TRACK_KEY_VERSION } from '../keyMigration';
import { chromagram, estimateKey } from './key';
import { danceabilityFrom, energyFrom, extractFeatures, type LoudnessFeatures } from './features';

const CACHE_FILE = dataDir('index', 'analysis.json');
const MAX_BYTES = 2_000_000; // a 30s preview is ~500KB; refuse anything much larger
export const ANALYSIS_TIMEOUT_MS = 8000;

export interface Analysis {
  bpm?: number;
  camelot?: string;
  energy?: number;
  danceability?: number;
  /** 3 = key/energy/danceability tuned on the U2 bench (2026-11-02); older entries are re-analysed. */
  v: 3;
  /** Raw inputs of energy/danceability and the key estimate's confidence: set by analysePcm, for fitting (bench). Not cached. */
  features?: LoudnessFeatures;
  keyConfidence?: number;
}

const MIN_SECONDS = 5;
const SILENCE_RMS = 1e-3; // about -60 dBFS

/** Folds an estimate into the usual DJ range, correcting octave errors by halving or doubling. */
export function foldBpm(bpm: number): number {
  let b = bpm;
  while (b > 175) b /= 2;
  while (b < 70) b *= 2;
  return Math.round(b * 10) / 10;
}

const TARGET_RATE = 44100; // music-tempo hard-codes a 44.1kHz frame grid (hopSize 441 = 10ms)

function resample(pcm: Float32Array, from: number): Float32Array {
  if (from === TARGET_RATE) return pcm;
  const ratio = from / TARGET_RATE;
  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    out[i] = pcm[i0] * (1 - frac) + (pcm[Math.min(i0 + 1, pcm.length - 1)] ?? 0) * frac;
  }
  return out;
}

/** Estimates tempo from mono PCM (-1..1 floats). Returns undefined when no confident beat pattern is found. */
export function estimateBpm(pcm: Float32Array, sampleRate: number): number | undefined {
  if (pcm.length < sampleRate * 5) return undefined;
  try {
    const mt = new MusicTempo(resample(pcm, sampleRate), { maxBeatInterval: 1, minBeatInterval: 0.3 }) as {
      tempo: number | string;
      beats?: number[];
    };
    const tempo = Number(mt.tempo);
    if (!Number.isFinite(tempo) || tempo <= 0 || !mt.beats || mt.beats.length < 8) return undefined;
    return foldBpm(tempo);
  } catch {
    return undefined;
  }
}

function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** Estimates every field from mono PCM; undefined for silence, too-short audio, or when nothing could be found. */
export function analysePcm(pcm: Float32Array, sampleRate: number): Analysis | undefined {
  if (pcm.length < sampleRate * MIN_SECONDS) return undefined;
  let sq = 0;
  for (let i = 0; i < pcm.length; i++) sq += pcm[i] * pcm[i];
  if (Math.sqrt(sq / pcm.length) < SILENCE_RMS) return undefined;
  const bpm = estimateBpm(pcm, sampleRate);
  const key = estimateKey(chromagram(pcm, sampleRate));
  const camelot = key?.camelot;
  const features = extractFeatures(pcm, sampleRate);
  const out: Analysis = {
    bpm,
    camelot,
    energy: energyFrom(features),
    danceability: danceabilityFrom(features, bpm),
    v: 3,
    features,
    keyConfidence: key?.confidence,
  };
  return out;
}

/** Decodes MP3 bytes once, in memory, and estimates bpm, key, energy, danceability. Nothing is written to disk. */
export async function analyseFull(bytes: Uint8Array): Promise<Analysis | undefined> {
  const decoder = new MPEGDecoder();
  try {
    await decoder.ready;
    const { channelData, sampleRate, samplesDecoded } = decoder.decode(bytes);
    if (!samplesDecoded) return undefined;
    return analysePcm(downmix(channelData), sampleRate);
  } finally {
    decoder.free();
  }
}

/** Stored inside the cache object; never a trackKey (those always contain "|"). */
const KEY_VERSION_FIELD = '__keyVersion';

export async function readCache(file = CACHE_FILE): Promise<Record<string, Analysis>> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
  const version = typeof raw[KEY_VERSION_FIELD] === 'number' ? (raw[KEY_VERSION_FIELD] as number) : 1;
  delete raw[KEY_VERSION_FIELD];
  let cache = raw as Record<string, Analysis>;
  if (version < TRACK_KEY_VERSION) {
    // keys written with an older trackKeyOf: drop the ones that may be stale (re-analysed on demand)
    cache = dropStaleKeys(cache);
    await writeCache(cache, file);
  }
  return cache;
}

async function writeCache(cache: Record<string, Analysis>, file = CACHE_FILE): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ ...cache, [KEY_VERSION_FIELD]: TRACK_KEY_VERSION }));
    await fs.rename(tmp, file);
  } catch {
    // cache is best-effort (read-only filesystems on serverless hosts)
  }
}

async function fetchAndAnalyse(previewUrl: string): Promise<Analysis | undefined> {
  const res = await fetchWithTimeout(previewUrl, { timeoutMs: ANALYSIS_TIMEOUT_MS - 1000, retries: 0 });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_BYTES) return undefined;
  return analyseFull(buf);
}

/** Fetches a Deezer preview transiently and estimates bpm, key, energy, danceability; results cached by trackKey. Never throws. */
export async function analysePreview(trackKey: string, previewUrl: string): Promise<Partial<Track>> {
  let cached: Analysis | undefined;
  try {
    const cache = await readCache();
    cached = cache[trackKey];
    // v1 entries were bpm-only, v2 ones came from the untuned key/energy/danceability: re-analyse both
    let hit: Analysis;
    if (cached && cached.v === 3) hit = cached;
    else {
      const fresh = await fetchAndAnalyse(previewUrl);
      if (!fresh) return staleOnly(cached);
      const { features: _f, keyConfidence: _k, ...slim } = fresh; // diagnostics are not cached
      hit = cache[trackKey] = slim;
      await writeCache(cache);
    }
    const out: Partial<Track> = {};
    if (hit.bpm !== undefined) out.bpm = hit.bpm;
    if (hit.camelot !== undefined) out.camelot = hit.camelot;
    if (hit.energy !== undefined) out.energy = hit.energy;
    if (hit.danceability !== undefined) out.danceability = hit.danceability;
    return out;
  } catch {
    return staleOnly(cached);
  }
}

/** An older entry that could not be upgraded still has a usable bpm (tempo estimation did not change). */
function staleOnly(cached: Analysis | undefined): Partial<Track> {
  return cached && cached.v !== 3 && cached.bpm !== undefined ? { bpm: cached.bpm } : {};
}
