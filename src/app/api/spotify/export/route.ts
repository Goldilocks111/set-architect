import { createPlaylist } from '@/lib/spotify/api';
import { withSpotify } from '@/lib/spotify/route';

const ID = /^[A-Za-z0-9]{10,40}$/;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    spotifyIds?: unknown;
  } | null;
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const ids = Array.isArray(body?.spotifyIds) ? body.spotifyIds : [];
  if (!name || ids.length === 0 || ids.length > 500 || !ids.every((i) => typeof i === 'string' && ID.test(i))) {
    return Response.json({ error: 'name and spotifyIds[] required' }, { status: 400 });
  }
  return withSpotify(request, async (token) =>
    Response.json({ url: await createPlaylist(token, name, ids as string[]) })
  );
}
