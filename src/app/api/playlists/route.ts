import { encodeArc, toArc } from '@/lib/arc';
import { isDemoMode } from '@/lib/demo';
import type { TrackRow } from '@/lib/supabase/types';
import type { Track } from '@/types/track';
import { sanitizeTrack } from '@/components/trackSanitize';
import { rowToTrack, trackToRow, type SavedPlaylist } from './mapping';

const MAX_TRACKS = 200;

const demoResponse = () =>
  Response.json(
    { error: 'Saved playlists need an account. In demo mode your set is kept in this browser.', demo: true },
    { status: 501 }
  );

async function authed() {
  const [{ getCurrentUser }, { createClient }] = await Promise.all([
    import('@/lib/supabase/auth'),
    import('@/lib/supabase/server'),
  ]);
  const user = await getCurrentUser();
  return { user, supabase: await createClient() };
}

const unauthorized = () => Response.json({ error: 'Sign in to save and load playlists.' }, { status: 401 });
const failed = (message: string) => Response.json({ error: message }, { status: 500 });

export async function GET() {
  if (isDemoMode()) return demoResponse();
  const { user, supabase } = await authed();
  if (!user) return unauthorized();

  const { data: lists, error } = await supabase
    .from('playlists')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  if (error) return failed('Could not load playlists.');
  if (!lists?.length) return Response.json({ playlists: [] });

  const { data: entries, error: entriesError } = await supabase
    .from('playlist_tracks')
    .select('*')
    .in('playlist_id', lists.map((p) => p.id))
    .order('position');
  if (entriesError) return failed('Could not load playlist tracks.');

  const trackIds = [...new Set((entries ?? []).map((e) => e.track_id))];
  const { data: trackRows, error: tracksError } = trackIds.length
    ? await supabase.from('tracks').select('*').in('id', trackIds)
    : { data: [] as TrackRow[], error: null };
  if (tracksError) return failed('Could not load tracks.');
  const byId = new Map(
    (trackRows ?? [])
      .map((r) => sanitizeTrack(rowToTrack(r)))
      .filter((t): t is Track => t !== null)
      .map((t) => [t.id, t])
  );

  const playlists: SavedPlaylist[] = lists.map((p) => ({
    id: p.id,
    name: p.name,
    arc: toArc(p.arc_template),
    createdAt: p.created_at,
    tracks: (entries ?? [])
      .filter((e) => e.playlist_id === p.id)
      .map((e) => byId.get(e.track_id))
      .filter((t): t is Track => !!t),
  }));
  return Response.json({ playlists });
}

export async function POST(request: Request) {
  if (isDemoMode()) return demoResponse();

  let body: { name?: unknown; arc?: unknown; template?: unknown; tracks?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be JSON: { name, arc, tracks }' }, { status: 400 });
  }
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : 'Untitled set';
  const tracks = Array.isArray(body?.tracks)
    ? body.tracks.map(sanitizeTrack).filter((t): t is Track => t !== null).slice(0, MAX_TRACKS)
    : [];

  const { user, supabase } = await authed();
  if (!user) return unauthorized();

  const { canCreatePlaylist, EntitlementsUnavailableError } = await import('@/lib/billing/entitlements');
  try {
    if (!(await canCreatePlaylist(user.id))) {
      return Response.json({ error: 'The free plan keeps one saved set. Upgrade to save more.' }, { status: 402 });
    }
  } catch (e) {
    if (e instanceof EntitlementsUnavailableError) {
      return Response.json({ error: 'entitlements unavailable' }, { status: 503 });
    }
    throw e;
  }

  // The shared track catalogue is service-role-write only; playlist rows go through the user's RLS.
  if (tracks.length) {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const admin = createAdminClient();
    if (!admin) return failed('Track catalogue is not configured (SUPABASE_SERVICE_ROLE_KEY missing).');
    // Insert-only: existing catalogue rows are shared by every user and are never overwritten from client input.
    const { error } = await admin
      .from('tracks')
      .upsert(tracks.map(trackToRow), { onConflict: 'id', ignoreDuplicates: true });
    if (error) return failed('Could not store the tracks for this set.');
  }

  const { data: created, error } = await supabase
    .from('playlists')
    .insert({ user_id: user.id, name, arc_template: encodeArc(toArc(body.arc ?? body.template)) })
    .select('*')
    .single();
  if (error || !created) return failed('Could not save the set.');

  if (tracks.length) {
    const { error: entriesError } = await supabase
      .from('playlist_tracks')
      .insert(tracks.map((t, position) => ({ playlist_id: created.id, position, track_id: t.id })));
    if (entriesError) {
      await supabase.from('playlists').delete().eq('id', created.id);
      return failed('Could not save the tracks in this set.');
    }
  }

  const playlist: SavedPlaylist = {
    id: created.id,
    name: created.name,
    arc: toArc(created.arc_template),
    createdAt: created.created_at,
    tracks,
  };
  return Response.json({ playlist }, { status: 201 });
}

export async function DELETE(request: Request) {
  if (isDemoMode()) return demoResponse();
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'Pass the playlist id as ?id=' }, { status: 400 });
  const { user, supabase } = await authed();
  if (!user) return unauthorized();
  const { error } = await supabase.from('playlists').delete().eq('id', id).eq('user_id', user.id);
  if (error) return failed('Could not delete the set.');
  return new Response(null, { status: 204 });
}
