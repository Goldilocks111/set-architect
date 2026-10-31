import { NextResponse, type NextRequest } from 'next/server';
import { isDemoMode } from '@/lib/demo';

// Demo mode (no Supabase env): everything is open. Otherwise /admin and the builder (/) require a session.
export async function middleware(request: NextRequest) {
  if (isDemoMode()) return NextResponse.next();
  const { updateSession } = await import('@/lib/supabase/middleware');
  return updateSession(request);
}

export const config = {
  matcher: ['/admin/:path*', '/', '/api/admin/:path*'],
};
