import { isDemoMode } from '@/lib/demo';
import { createClient } from './server';

export type AuthedUser = { id: string; email: string | null; isAdmin: boolean };

/** Current user, or null. In demo mode returns a synthetic admin so the whole app is explorable. */
export async function getCurrentUser(): Promise<AuthedUser | null> {
  if (isDemoMode()) return { id: 'demo-user', email: null, isAdmin: true };
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', data.user.id).maybeSingle();
  return { id: data.user.id, email: data.user.email ?? null, isAdmin: profile?.is_admin ?? false };
}
