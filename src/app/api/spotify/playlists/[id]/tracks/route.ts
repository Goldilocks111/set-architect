import { playlistTracks } from '@/lib/spotify/api';
import { withSpotify } from '@/lib/spotify/route';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withSpotify(request, async (token) => Response.json({ tracks: await playlistTracks(token, id) }));
}
