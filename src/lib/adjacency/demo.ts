import { readFileSync } from 'node:fs';
import path from 'node:path';
import { trackKeyOf, type Track } from '../../types/track';
import { addEdge, emptyData, writeData } from './store';

export const DEMO_TRACKS_PATH = path.join(process.cwd(), 'data', 'seed', 'tracks.demo.json');
export const DEMO_ADJACENCY_PATH = path.join(process.cwd(), 'data', 'seed', 'adjacency.demo.json');

function camelotDistance(a?: string, b?: string): number {
  const pa = a?.match(/^(\d{1,2})([AB])$/);
  const pb = b?.match(/^(\d{1,2})([AB])$/);
  if (!pa || !pb) return 99;
  const raw = Math.abs(Number(pa[1]) - Number(pb[1]));
  const wheel = Math.min(raw, 12 - raw);
  return wheel + (pa[2] === pb[2] ? 0 : 1);
}

/**
 * Writes plausible fake adjacency (data/seed/adjacency.demo.json) from the demo seed tracks:
 * tracks close in key, energy and BPM follow each other, lower energy before higher. Counts 1-5.
 */
export function buildDemoAdjacency(
  tracksPath: string = DEMO_TRACKS_PATH,
  outPath: string = DEMO_ADJACENCY_PATH
): void {
  const tracks = JSON.parse(readFileSync(/*turbopackIgnore: true*/ tracksPath, 'utf8')) as Track[];
  const data = emptyData();
  for (const t of tracks) data.names[trackKeyOf(t.artist, t.title)] = { artist: t.artist, title: t.title };

  for (let i = 0; i < tracks.length; i++) {
    for (let j = 0; j < tracks.length; j++) {
      const a = tracks[i];
      const b = tracks[j];
      if (i === j) continue;
      const rising = (a.energy ?? 0) < (b.energy ?? 0) || ((a.energy ?? 0) === (b.energy ?? 0) && i < j);
      if (!rising) continue;
      const key = camelotDistance(a.camelot, b.camelot);
      const energy = Math.abs((a.energy ?? 0) - (b.energy ?? 0));
      const bpm = Math.abs((a.bpm ?? 0) - (b.bpm ?? 0));
      if (key > 1 || energy > 1 || bpm > 3) continue;
      const count = Math.max(1, Math.min(5, 5 - key - energy - Math.floor(bpm / 2) + ((i + j) % 2)));
      addEdge(data, trackKeyOf(a.artist, a.title), trackKeyOf(b.artist, b.title), count);
    }
  }
  data.tracklists['demo'] = tracks.length;
  writeData(outPath, data);
}
