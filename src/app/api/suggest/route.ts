import { plannedLengthFor } from '@/components/playlistReducer';
import { sanitizeTrack } from '@/components/trackSanitize';
import { isDemoMode } from '@/lib/demo';
import type { ArcTemplate, Suggestion, Track } from '@/types/track';
import { ensureNeighborsFor } from '@/lib/adjacency/live';
import { assembleSuggestions, loadSuggestDeps, type CrateKnown } from './assemble';

const MAX_PLAYLIST = 200;
/** Mirrors CRATE_SEND_MAX on the client: a bigger payload is truncated, not trusted. */
const MAX_CRATE = 600;
const MAX_CRATE_TEXT = 200;
const MAX_STYLES = 10;

/** A crate item is an ordinary client track under tighter text caps; one bad item never rejects the request. */
function sanitizeCrate(raw: unknown): Track[] {
  if (!Array.isArray(raw)) return [];
  const out: Track[] = [];
  for (const item of raw.slice(0, MAX_CRATE)) {
    const o = item as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') continue;
    if ([o.id, o.artist, o.title].some((v) => typeof v === 'string' && v.length > MAX_CRATE_TEXT)) continue;
    const t = sanitizeTrack(o);
    if (!t) continue;
    const styles = Array.isArray(o.styles)
      ? o.styles.filter((s): s is string => typeof s === 'string' && s.trim() !== '' && s.length <= MAX_CRATE_TEXT).slice(0, MAX_STYLES)
      : [];
    out.push(styles.length ? Object.assign(t, { styles }) : t);
  }
  return out;
}

export async function POST(request: Request) {
  let body: { playlist?: unknown; template?: unknown; plannedLength?: unknown; crate?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be JSON: { playlist, template }' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.playlist)) {
    return Response.json({ error: 'playlist must be an array of tracks' }, { status: 400 });
  }

  const template: ArcTemplate = body.template === '120min' ? '120min' : '60min';
  const plannedLength =
    typeof body.plannedLength === 'number' && body.plannedLength > 0 && body.plannedLength <= MAX_PLAYLIST
      ? Math.round(body.plannedLength)
      : plannedLengthFor(template);
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

  const result: { suggestions: Suggestion[]; crateKnown?: CrateKnown[]; digging?: true } = await assembleSuggestions(
    { playlist, template, plannedLength, crate },
    await loadSuggestDeps()
  );
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
