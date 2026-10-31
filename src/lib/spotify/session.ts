import {
  clearCookieHeader,
  open,
  readCookie,
  seal,
  SESSION_COOKIE,
  setCookieHeader,
} from "./cookie";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

interface Stored {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface SpotifySession {
  accessToken: string;
  /** Set-Cookie value to attach to the response when the token was refreshed. */
  setCookie?: string;
}

export const redirectUri = (request: Request) =>
  `${new URL(request.url).origin}/api/spotify/callback`;

const creds = () => {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  return id && secret ? { id, secret } : undefined;
};

export const spotifyConfigured = () => !!creds();

async function tokenRequest(params: Record<string, string>): Promise<{
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const c = creds();
  if (!c) throw new Error("spotify not configured");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`spotify token endpoint ${res.status}`);
  return res.json();
}

const toCookie = (s: Stored) =>
  setCookieHeader(SESSION_COOKIE, seal(s), THIRTY_DAYS);

/** Exchange an authorization code; returns the Set-Cookie value holding the encrypted tokens. */
export async function exchangeCode(
  code: string,
  redirect: string,
): Promise<string> {
  const data = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
  });
  if (!data.access_token || !data.refresh_token)
    throw new Error("spotify token response incomplete");
  return toCookie({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
  });
}

/** Valid access token from the session cookie (refreshing if expired), or null when not connected. */
export async function getSpotifySession(
  request: Request,
): Promise<SpotifySession | null> {
  const stored = open<Stored>(readCookie(request, SESSION_COOKIE));
  if (!stored?.accessToken || !stored.refreshToken) return null;
  if (Date.now() < stored.expiresAt) return { accessToken: stored.accessToken };
  try {
    const data = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    });
    if (!data.access_token) return null;
    const next: Stored = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? stored.refreshToken,
      expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
    };
    return { accessToken: next.accessToken, setCookie: toCookie(next) };
  } catch {
    return null;
  }
}

export const disconnectCookie = () => clearCookieHeader(SESSION_COOKIE);
