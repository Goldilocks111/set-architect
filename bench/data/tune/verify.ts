/**
 * U2 tuning, verification fetch pass: runs the SHIPPED analyser (analysePcm) end to end on every labelled bench row's
 * Deezer preview and scores it against the reference values, the same way bench/data/run.ts does. Prints only.
 * Key settings were picked by nested leave-one-out on these tracks (bench/data/tune/key.ts) and energy/danceability
 * coefficients were fitted on them, so treat these numbers as a parity check, not as held-out accuracy.
 *
 *   npx tsx bench/data/tune/verify.ts <bench-result.json>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analysePcm } from '../../../src/lib/analysis/previewAnalysis';
import { keyAgreement, LOCAL_SOURCE, maeEnergy, type DataRow } from '../score';
import { DEEZER_DAILY_CAP, previewSession } from './preview';

async function main(): Promise<void> {
  const benchFile = process.argv[2];
  if (!benchFile) throw new Error('usage: verify.ts <bench-result.json>');
  const bench = JSON.parse(readFileSync(benchFile, 'utf8')) as { rows: DataRow[] };
  const tracks: Array<{ id: string; artist: string; title: string }> = JSON.parse(
    readFileSync(join(__dirname, '../../search/tracks.json'), 'utf8'),
  );
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const labelled = bench.rows.filter((r) => r.local && (['camelot', 'energy', 'danceability'] as const).some((f) => r.fields[f] !== undefined && r.sources[f] !== LOCAL_SOURCE));
  const session = previewSession();
  const start = session.gate.count;
  console.log(`${labelled.length} labelled rows; deezer count today ${start}/${DEEZER_DAILY_CAP}`);

  const key = { exact: 0, relative: 0, fifth: 0, miss: 0, none: 0 };
  const energy: Array<[number, number]> = [];
  const dance: Array<[number, number]> = [];
  let analysed = 0;
  for (const [i, row] of labelled.entries()) {
    const t = byId.get(row.id);
    if (!t) continue;
    try {
      const got = await session.fetchPcm(t.artist, t.title);
      if (typeof got === 'string') {
        console.log(`[${i + 1}] ${row.id}: ${got}`);
        continue;
      }
      const a = analysePcm(got.pcm, got.sampleRate);
      if (!a) continue;
      analysed++;
      const ref = (f: 'camelot' | 'energy' | 'danceability') => (row.sources[f] !== LOCAL_SOURCE ? row.fields[f] : undefined);
      const rk = ref('camelot');
      if (rk !== undefined) {
        if (a.camelot === undefined) key.none++;
        else key[keyAgreement(String(rk), a.camelot)]++;
      }
      const re = ref('energy');
      if (re !== undefined && a.energy !== undefined) energy.push([Number(re), a.energy]);
      const rd = ref('danceability');
      if (rd !== undefined && a.danceability !== undefined) dance.push([Number(rd), a.danceability]);
      console.log(`[${i + 1}/${labelled.length}] ${row.id}: key ${a.camelot ?? '-'} (ref ${rk ?? '-'}, conf ${a.keyConfidence?.toFixed(2) ?? '-'}) energy ${a.energy} (ref ${re ?? '-'}) dance ${a.danceability} (ref ${rd ?? '-'})`);
    } catch (err) {
      console.log(`[${i + 1}] ${row.id}: ${(err as Error).message}`);
      if (session.guard.stopped.size || session.guard.refused.deezer) break;
    }
  }
  const n = key.exact + key.relative + key.fifth + key.miss;
  const pct = (x: number) => `${((100 * x) / Math.max(1, n)).toFixed(0)}%`;
  console.log(`\nanalysed ${analysed}/${labelled.length}`);
  console.log(`key: exact ${key.exact} relative ${key.relative} fifth ${key.fifth} miss ${key.miss} none ${key.none} | exact+relative ${pct(key.exact + key.relative)} miss ${pct(key.miss)} (n=${n})`);
  console.log(`energy MAE ${maeEnergy(energy).toFixed(3)} (n=${energy.length})  danceability MAE ${maeEnergy(dance).toFixed(3)} (n=${dance.length})`);
  console.log(`deezer calls this run: ${session.gate.count - start} (today ${session.gate.count}/${DEEZER_DAILY_CAP})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
