import { NextResponse, type NextRequest } from 'next/server';
import { isDemoMode } from '@/lib/demo';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  if (isDemoMode()) return NextResponse.redirect(`${origin}/`);
  const code = searchParams.get('code');
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/welcome`);
  }
  return NextResponse.redirect(`${origin}/login?error=callback`);
}
