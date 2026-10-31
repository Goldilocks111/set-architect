import { plannedLengthFor } from '@/components/playlistReducer';
import { sanitizeTrack } from '@/components/trackSanitize';
import { isDemoMode } from '@/lib/demo';
import type { ArcTemplate, Track } from '@/types/track';
import { assembleSuggestions, loadSuggestDeps } from './assemble';

const MAX_PLAYLIST = 200;

export async function POST(request: Request) {
  let body: { playlist?: unknown; template?: unknown; plannedLength?: unknown };
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

  const result = await assembleSuggestions({ playlist, template, plannedLength }, await loadSuggestDeps());

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
