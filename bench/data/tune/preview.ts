/**
 * Shared by the tuning fetch passes: finds a track's Deezer preview (search counted against today's shared Deezer
 * budget) and decodes it to mono PCM in memory. Audio is never written to disk.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { MPEGDecoder } from 'mpg123-decoder';
import { dataDir } from '../../../src/lib/dataDir';
import { RequestGate, dayKey, loadDailyCounts, saveDailyCounts } from '../../search/guard';
import { createFetchGuard, type FetchGuard } from '../guardFetch';

/** Deezer search calls allowed for the whole day (the U2 bench used 202; Task 3 may add at most 180). */
export const DEEZER_DAILY_CAP = 382;

const norm = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

export interface PreviewSession {
  guard: FetchGuard;
  gate: RequestGate;
  /** undefined (with a logged reason) when there is no matching Deezer track or the preview can't be fetched. */
  fetchPcm(artist: string, title: string): Promise<{ pcm: Float32Array; sampleRate: number; deezerId: number; label: string } | string>;
}

export function previewSession(): PreviewSession {
  const dailyFile = dataDir('search', 'bench-requests.json');
  const day = dayKey();
  const store = { read: () => (existsSync(dailyFile) ? readFileSync(dailyFile, 'utf8') : null), write: (t: string) => writeFileSync(dailyFile, t) };
  const gate: RequestGate = new RequestGate(DEEZER_DAILY_CAP, loadDailyCounts(store, day).deezer ?? 0, () => {
    const fresh = loadDailyCounts(store, day);
    fresh.deezer = gate.count;
    saveDailyCounts(store, day, fresh);
  });
  const guard = createFetchGuard({ real: globalThis.fetch, gates: new Map([['deezer', gate]]), gapMs: { deezer: 1100, 'deezer-cdn': 1100 } });

  return {
    guard,
    gate,
    async fetchPcm(artist, title) {
      const res = await guard.fetch(`https://api.deezer.com/search?q=${encodeURIComponent(`${artist} ${title}`)}&limit=5`);
      const list = ((await res.json()) as { data?: Array<{ id: number; title: string; preview?: string; artist?: { name: string } }> }).data ?? [];
      const want = norm(artist);
      const hit = list.find((d) => {
        const got = norm(d.artist?.name ?? '');
        return d.preview && got && (want.includes(got) || got.includes(want));
      });
      if (!hit) return 'no deezer hit';
      const audio = await guard.fetch(hit.preview!, { signal: AbortSignal.timeout(10_000) });
      if (!audio.ok) return `preview HTTP ${audio.status}`;
      const bytes = new Uint8Array(await audio.arrayBuffer());
      const decoder = new MPEGDecoder();
      try {
        await decoder.ready;
        const d = decoder.decode(bytes);
        return { pcm: downmix(d.channelData), sampleRate: d.sampleRate, deezerId: hit.id, label: `${hit.artist?.name} - ${hit.title}` };
      } finally {
        decoder.free();
      }
    },
  };
}
