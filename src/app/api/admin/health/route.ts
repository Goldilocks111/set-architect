import { getAdapterHealth } from '@/lib/supabase/adapter-health';
import { getCurrentUser } from '@/lib/supabase/auth';

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 });
  return Response.json({ adapters: await getAdapterHealth() });
}
