import { me } from "@/lib/spotify/api";
import { withSpotify } from "@/lib/spotify/route";

export async function GET(request: Request) {
  return withSpotify(
    request,
    async (token) =>
      Response.json({
        connected: true,
        displayName: (await me(token)).displayName,
      }),
    () => Response.json({ connected: false }),
  );
}
