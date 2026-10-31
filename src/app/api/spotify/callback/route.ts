import { timingSafeEqual } from 'node:crypto';
import { clearCookieHeader, readCookie, STATE_COOKIE } from '@/lib/spotify/cookie';
import { appOrigin, exchangeCode, redirectUri } from '@/lib/spotify/session';

function sameState(a: string | null, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function home(request: Request, query = '') {
  return new Response(null, {
    status: 302,
    headers: { Location: new URL(`/${query}`, appOrigin(request)).toString() },
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
  if (!code || !sameState(params.get('state'), expected)) {
    console.error('[spotify callback] state check failed', {
      hasCode: !!code,
      hasStateParam: !!params.get('state'),
      hasStateCookie: !!expected,
    });
    return res(home(request, '?spotify=error-state'));
  }

  try {
    const cookie = await exchangeCode(code, redirectUri(request));
    const r = res(home(request, '?spotify=connected'));
    r.headers.append('Set-Cookie', cookie);
    return r;
  } catch (e) {
    console.error('[spotify callback] token exchange failed:', (e as Error).message);
    return res(home(request, '?spotify=error-exchange'));
  }
}
