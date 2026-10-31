import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from './types';

/** Refreshes the auth cookie and redirects anonymous visitors of gated paths to /login. */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );
  const { data } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isApi = path.startsWith('/api/');
  if (!data.user) {
    if (isApi) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  if (path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/admin')) {
    const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', data.user.id).maybeSingle();
    if (!profile?.is_admin) {
      if (isApi) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      return NextResponse.rewrite(new URL('/404', request.url), { status: 404 });
    }
  }
  return response;
}
