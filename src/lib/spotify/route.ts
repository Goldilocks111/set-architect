import { SpotifyApiError } from "./api";
import { getSpotifySession } from "./session";

const notConnected = () =>
  Response.json({ error: "not connected" }, { status: 401 });

/**
 * Runs a handler with the caller's Spotify access token, attaching a refreshed session cookie if one
 * was minted. Not connected -> `onDisconnected()` (default 401).
 */
export async function withSpotify(
  request: Request,
  handler: (token: string) => Promise<Response>,
  onDisconnected: () => Response = notConnected,
): Promise<Response> {
  const session = await getSpotifySession(request);
  if (!session) return onDisconnected();
  let res: Response;
  try {
    res = await handler(session.accessToken);
  } catch (err) {
    const upstream = err instanceof SpotifyApiError ? err.status : 0;
    if (upstream === 401) res = notConnected();
    else if (upstream === 403)
      res = Response.json(
        {
          error:
            "Spotify refused this request (dev-mode user cap or missing scope).",
        },
        { status: 403 },
      );
    else
      res = Response.json(
        { error: "Spotify request failed." },
        { status: 502 },
      );
  }
  if (session.setCookie) res.headers.append("Set-Cookie", session.setCookie);
  return res;
}
