import { sanitizeTrack } from '@/components/trackSanitize';
import { arcInput } from '@/lib/arc';
import { isDemoMode } from '@/lib/demo';
import type { Suggestion, Track } from '@/types/track';
import { ensureNeighborsFor } from '@/lib/adjacency/live';
import { assembleSuggestions, loadSuggestDeps, type CrateKnown } from './assemble';

const MAX_PLAYLIST = 200;
/** Mirrors CRATE_SEND_MAX on the client: a bigger payload is truncated, not trusted. */
const MAX_CRATE = 600;
const MAX_CRATE_TEXT = 200;

/** A crate item is an ordinary client track under tighter text caps; one bad item never rejects the request. */
function sanitizeCrate(raw: unknown): Track[] {
  if (!Array.isArray(raw)) return [];
  const out: Track[] = [];
  for (const item of raw.slice(0, MAX_CRATE)) {
    const o = item as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') continue;
    if ([o.id, o.artist, o.title].some((v) => typeof v === 'string' && v.length > MAX_CRATE_TEXT)) continue;
    const t = sanitizeTrack(o); // keeps a bounded styles list, as for set tracks
    if (t) out.push(t);
  }
  return out;
}

export async function POST(request: Request) {
  let body: { playlist?: unknown; arc?: unknown; template?: unknown; playFraction?: unknown; crate?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be JSON: { playlist, arc }' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.playlist)) {
    return Response.json({ error: 'playlist must be an array of tracks' }, { status: 400 });
  }

  const { arc, playFraction } = arcInput(body);
  const playlist = body.playlist
    .map(sanitizeTrack)
    .filter((t): t is Track => t !== null)
    .slice(0, MAX_PLAYLIST);
  const crate = sanitizeCrate(body.crate);

  // TODO(post-V1): rate limiting for demo mode and anonymous users is deferred; only signed-in free users are gated.
  let gatedUserId: string | null = null;
  if (!isDemoMode()) {
    const { getCurrentUser } = await import('@/lib/supabase/auth');
    const user = await getCurrentUser();
    if (user) {
      const { canSuggest, EntitlementsUnavailableError } = await import('@/lib/billing/entitlements');
      try {
        if (!(await canSuggest(user.id))) {
          return Response.json({ error: 'Daily suggestion limit reached. Upgrade for unlimited suggestions.' }, { status: 429 });
        }
      } catch (e) {
        if (e instanceof EntitlementsUnavailableError) {
          return Response.json({ error: 'entitlements unavailable' }, { status: 503 });
        }
        throw e;
      }
      gatedUserId = user.id;
    }
  }

  // Fire-and-forget: ingestion runs in the background queue; this request uses whatever the index has now.
  let digging = false;
  const last = playlist[playlist.length - 1];
  if (last) {
    try {
      digging = (await ensureNeighborsFor(last.artist, last.title)).digging;
    } catch {
      digging = false;
    }
  }

  const { suggestions, crateKnown } = await assembleSuggestions({ playlist, arc, playFraction, crate }, await loadSuggestDeps());
  const result: { suggestions: Suggestion[]; crateKnown?: CrateKnown[]; digging?: true } = { suggestions, crateKnown };
  if (digging) result.digging = true;

  if (gatedUserId) {
    const { recordSuggestion, EntitlementsUnavailableError } = await import('@/lib/billing/entitlements');
    try {
      await recordSuggestion(gatedUserId);
    } catch (e) {
      if (e instanceof EntitlementsUnavailableError) {
        return Response.json({ error: 'entitlements unavailable' }, { status: 503 });
      }
      throw e;
    }
  }
  return Response.json(result);
}
