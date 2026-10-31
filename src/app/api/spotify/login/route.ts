import { randomBytes } from "node:crypto";
import { setCookieHeader, STATE_COOKIE } from "@/lib/spotify/cookie";
import { redirectUri, spotifyConfigured } from "@/lib/spotify/session";

const SCOPES =
  "playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private";

export async function GET(request: Request) {
  if (!spotifyConfigured())
    return Response.json({ error: "spotify not configured" }, { status: 503 });
  const state = randomBytes(16).toString("hex");
  const url = new URL("https://accounts.spotify.com/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SPOTIFY_CLIENT_ID as string,
    scope: SCOPES,
    redirect_uri: redirectUri(request),
    state,
  }).toString();
  const res = new Response(null, {
    status: 302,
    headers: { Location: url.toString() },
  });
  res.headers.append("Set-Cookie", setCookieHeader(STATE_COOKIE, state, 600));
  return res;
}
