import { isDemoMode } from '@/lib/demo';
import { missingEssentials } from '@/lib/completeness';
import { putManual, putManualMany } from '@/lib/metadataCache';
import { validateOverride, type OverrideFields } from '@/lib/overrideValidation';
import { trackKeyOf, type Track } from '@/types/track';

const bad = (error: string) => Response.json({ error }, { status: 400 });
/** Mixed In Key libraries run to thousands of rows; the client chunks to this size. */
export const MAX_BATCH = 2000;

const clean = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');

function trackFrom(key: string, artist: string, title: string, entry: ReturnType<typeof putManual>): Track {
  const track: Track = { id: key, artist, title, ...entry.fields, sources: { ...entry.sources } };
  const missing = missingEssentials(track);
  if (missing.length) track.unresolved = { reason: entry.reason ?? 'not-found', missing, ...(entry.retryAt ? { retryAt: entry.retryAt } : {}) };
  return track;
}

/**
 * Imported rows get their Last.fm styles in the background (paced, budgeted, deduped by the resolver queue). Stops at
 * the queue cap rather than evicting waiting lookups; never fails the import.
 */
async function queueImportedStyles(tracks: Track[]): Promise<void> {
  try {
    const { queueStyles, stylesQueueLength, STYLES_QUEUE_CAP } = await import('@/lib/resolver');
    for (const t of tracks) {
      if (stylesQueueLength() >= STYLES_QUEUE_CAP) break;
      queueStyles(t);
    }
  } catch {
    // styles are optional: the import already succeeded
  }
}

/**
 * Manual values for one track: POST {artist, title, fields: {bpm?, camelot?, energy?, danceability?}}
 * or a batch: POST {items: [{artist, title, fields}]} (<= MAX_BATCH) -> {applied, rejected: [{index, error}], tracks}
 */
export async function POST(request: Request) {
  // Overrides beat every provider forever and are global, so this write needs the same care as saving a playlist.
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return Response.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }
  const origin = request.headers.get('origin');
  if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin !== null && origin !== new URL(request.url).origin)) {
    return Response.json({ error: 'Cross-origin requests are not allowed' }, { status: 403 });
  }
  if (!isDemoMode()) {
    const { getCurrentUser } = await import('@/lib/supabase/auth');
    if (!(await getCurrentUser())) return Response.json({ error: 'Sign in to edit track values.' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad('Invalid JSON body');
  }
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (b.items !== undefined) {
    if (!Array.isArray(b.items)) return bad('items must be an array');
    if (b.items.length > MAX_BATCH) return Response.json({ error: `At most ${MAX_BATCH} items per request` }, { status: 413 });
    const rejected: Array<{ index: number; error: string }> = [];
    const valid: Array<{ key: string; artist: string; title: string; fields: OverrideFields }> = [];
    b.items.forEach((raw, index) => {
      const it = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const artist = clean(it.artist);
      const title = clean(it.title);
      if (!artist || !title) return void rejected.push({ index, error: 'Pass both artist and title' });
      const checked = validateOverride(it.fields);
      if (!checked.ok) return void rejected.push({ index, error: checked.error });
      valid.push({ key: trackKeyOf(artist, title), artist, title, fields: checked.fields });
    });
    const entries = putManualMany(valid.map((v) => ({ key: v.key, fields: v.fields })));
    const tracks = valid.map((v, i) => trackFrom(v.key, v.artist, v.title, entries[i]));
    await queueImportedStyles(tracks);
    return Response.json({ applied: valid.length, rejected, tracks });
  }
  const artist = clean(b.artist);
  const title = clean(b.title);
  if (!artist || !title) return bad('Pass both artist and title');
  const checked = validateOverride(b.fields);
  if (!checked.ok) return bad(checked.error);

  const key = trackKeyOf(artist, title);
  return Response.json({ track: trackFrom(key, artist, title, putManual(key, checked.fields)) });
}
