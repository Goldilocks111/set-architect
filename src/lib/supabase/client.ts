import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './types';

export { isDemoMode } from '@/lib/demo';

/** Browser client. Call only when `isDemoMode()` is false. */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
