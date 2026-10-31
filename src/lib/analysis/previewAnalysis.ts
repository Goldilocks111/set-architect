import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from '@/lib/dataDir';
import { MPEGDecoder } from 'mpg123-decoder';
import MusicTempo from 'music-tempo';
import { fetchWithTimeout } from '../http';
import type { Track } from '@/types/track';

const CACHE_FILE = dataDir('index', 'analysis.json');
const MAX_BYTES = 2_000_000; // a 30s preview is ~500KB; refuse anything much larger
export const ANALYSIS_TIMEOUT_MS = 8000;

export interface Analysis {
  bpm: number;
}

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

/** Decodes MP3 bytes in memory and estimates BPM. Nothing is written to disk. */
export async function analyseMp3(bytes: Uint8Array): Promise<Analysis | undefined> {
  const decoder = new MPEGDecoder();
  try {
    await decoder.ready;
    const { channelData, sampleRate, samplesDecoded } = decoder.decode(bytes);
    if (!samplesDecoded) return undefined;
    const bpm = estimateBpm(downmix(channelData), sampleRate);
    return bpm === undefined ? undefined : { bpm };
  } finally {
    decoder.free();
  }
}

async function readCache(): Promise<Record<string, Analysis>> {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')) as Record<string, Analysis>;
  } catch {
    return {};
  }
}

async function writeCache(cache: Record<string, Analysis>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache));
  } catch {
    // cache is best-effort (read-only filesystems on serverless hosts)
  }
}

/** Fetches a Deezer preview transiently and estimates tempo; results cached by trackKey. Never throws. */
export async function analysePreview(trackKey: string, previewUrl: string): Promise<Partial<Track>> {
  try {
    const cache = await readCache();
    let hit: Analysis | undefined = cache[trackKey];
    if (!hit) {
      const res = await fetchWithTimeout(previewUrl, { timeoutMs: ANALYSIS_TIMEOUT_MS - 1000, retries: 0 });
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) return {};
      hit = await analyseMp3(buf);
      if (!hit) return {};
      cache[trackKey] = hit;
      await writeCache(cache);
    }
    return { bpm: hit.bpm };
  } catch {
    return {};
  }
}
