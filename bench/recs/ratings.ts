import { readFileSync } from 'node:fs';
import { summarizeRatings, RATING_MIN_BEATS, RATING_MIN_GOOD, RATING_PASS, type RatingExport, type RatingKey } from './score';

/** Scores the owner's /rate export against the key in the bench results file: engine vs baseline, per scenario. */
const [exportPath, resultsPath] = process.argv.slice(2);
if (!exportPath || !resultsPath) {
  console.error('usage: npm run bench:recs:ratings -- <setarchitect-ratings.json> <bench/recs/results/DAY.json>');
  process.exit(1);
}
const exp = JSON.parse(readFileSync(exportPath, 'utf8')) as RatingExport;
const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as { ratingFileId?: string; ratingKey?: RatingKey };
if (!results.ratingKey) {
  console.error(`${resultsPath} has no ratingKey (written by bench:recs)`);
  process.exit(1);
}
if (exp.fileId !== results.ratingFileId) {
  console.error(`the export is for rating file ${exp.fileId ?? '(none)'}, the results file for ${results.ratingFileId ?? '(none)'}`);
  process.exit(1);
}
const r = summarizeRatings(exp, results.ratingKey);
for (const row of r.rows) console.log(`${row.id}: engine ${row.engine ?? '-'}  baseline ${row.baseline ?? '-'}`);
console.log(`\nEngine rated >= ${RATING_PASS} on ${r.engineGood}/${r.total} (need ${RATING_MIN_GOOD}); engine above baseline on ${r.engineBeatsBaseline}/${r.total} (need ${RATING_MIN_BEATS}); ${r.rated} rated`);
console.log(`RATING: ${r.pass ? 'PASS' : 'FAIL'}`);
