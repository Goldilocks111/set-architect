import { clearCookieHeader, readCookie, STATE_COOKIE } from '@/lib/spotify/cookie';
import { exchangeCode, redirectUri } from '@/lib/spotify/session';

function home(request: Request, query = '') {
  return new Response(null, {
    status: 302,
    headers: { Location: new URL(`/${query}`, request.url).toString() },
  });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const expected = readCookie(request, STATE_COOKIE);
  const res = (r: Response) => {
    r.headers.append('Set-Cookie', clearCookieHeader(STATE_COOKIE));
    return r;
  };

  if (params.get('error')) return res(home(request, '?spotify=denied'));
  const code = params.get('code');
  if (!code || !expected || params.get('state') !== expected) return res(home(request, '?spotify=error'));

  try {
    const cookie = await exchangeCode(code, redirectUri(request));
    const r = res(home(request, '?spotify=connected'));
    r.headers.append('Set-Cookie', cookie);
    return r;
  } catch {
    return res(home(request, '?spotify=error'));
  }
}
