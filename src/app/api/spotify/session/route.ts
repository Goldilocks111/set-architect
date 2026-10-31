import { disconnectCookie } from '@/lib/spotify/session';

export async function DELETE() {
  const res = Response.json({ connected: false });
  res.headers.append('Set-Cookie', disconnectCookie());
  return res;
}
