import { listPlaylists } from '@/lib/spotify/api';
import { withSpotify } from '@/lib/spotify/route';

export async function GET(request: Request) {
  return withSpotify(request, async (token) => Response.json({ playlists: await listPlaylists(token) }));
}
