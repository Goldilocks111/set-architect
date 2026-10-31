import { playlistTracks, PlaylistBlockedError } from '@/lib/spotify/api';
import { withSpotify } from '@/lib/spotify/route';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return Response.json({ error: 'invalid playlist id' }, { status: 400 });
  return withSpotify(request, async (token) => {
    try {
      return Response.json({ tracks: await playlistTracks(token, id) });
    } catch (err) {
      if (err instanceof PlaylistBlockedError) {
        return Response.json(
          {
            error:
              "Spotify doesn't let apps read playlists you don't own (Spotify-made, label or followed playlists). Playlists you created yourself import fine.",
            blocked: true,
          },
          { status: 403 }
        );
      }
      throw err;
    }
  });
}
