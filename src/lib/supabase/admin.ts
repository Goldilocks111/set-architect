import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

/** Service-role client (bypasses RLS). Server only; null when not configured. */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
