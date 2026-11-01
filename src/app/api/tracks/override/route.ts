import { missingEssentials } from '@/lib/completeness';
import { getEntry, putManual } from '@/lib/metadataCache';
import { validateOverride } from '@/lib/overrideValidation';
import { trackKeyOf, type Track } from '@/types/track';

const bad = (error: string) => Response.json({ error }, { status: 400 });

/** Manual values for one track: POST {artist, title, fields: {bpm?, camelot?, energy?, danceability?}} */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad('Invalid JSON body');
  }
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const artist = typeof b.artist === 'string' ? b.artist.trim().slice(0, 200) : '';
  const title = typeof b.title === 'string' ? b.title.trim().slice(0, 200) : '';
  if (!artist || !title) return bad('Pass both artist and title');
  const checked = validateOverride(b.fields);
  if (!checked.ok) return bad(checked.error);

  const key = trackKeyOf(artist, title);
  const entry = putManual(key, checked.fields);
  const track: Track = { id: key, artist, title, ...entry.fields, sources: { ...entry.sources } };
  const missing = missingEssentials(track);
  if (missing.length) track.unresolved = { reason: getEntry(key)?.reason ?? 'not-found', missing, ...(entry.retryAt ? { retryAt: entry.retryAt } : {}) };
  return Response.json({ track });
}
