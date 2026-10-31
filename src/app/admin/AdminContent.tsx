import { notFound, redirect } from 'next/navigation';
import { isDemoMode } from '@/lib/demo';
import { getAdapterHealth } from '@/lib/supabase/adapter-health';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCurrentUser } from '@/lib/supabase/auth';

type UserRow = { email: string; plan: string; suggestions7d: number };

const DEMO_USERS: UserRow[] = [
  { email: 'dj.alpha@example.com', plan: 'pro', suggestions7d: 142 },
  { email: 'dj.beta@example.com', plan: 'free', suggestions7d: 17 },
];

async function loadUsers(): Promise<UserRow[]> {
  const db = createAdminClient();
  if (!db) return [];
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [profiles, subs, usage] = await Promise.all([
    db.from('profiles').select('id,email').order('created_at', { ascending: false }).limit(200),
    db.from('subscriptions').select('user_id,plan,status'),
    db.from('usage_events').select('user_id').eq('kind', 'suggestion').gte('created_at', since),
  ]);
  const plan = new Map((subs.data ?? []).map((s) => [s.user_id, s.status === 'active' || s.status === 'trialing' ? s.plan : 'free']));
  const counts = new Map<string, number>();
  for (const u of usage.data ?? []) counts.set(u.user_id, (counts.get(u.user_id) ?? 0) + 1);
  return (profiles.data ?? []).map((p) => ({
    email: p.email ?? p.id,
    plan: plan.get(p.id) ?? 'free',
    suggestions7d: counts.get(p.id) ?? 0,
  }));
}

export default async function AdminContent() {
  const demo = isDemoMode();
  if (!demo) {
    const user = await getCurrentUser();
    if (!user) redirect('/login?next=/admin');
    if (!user.isAdmin) notFound();
  }
  const [users, adapters] = await Promise.all([demo ? DEMO_USERS : loadUsers(), getAdapterHealth()]);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Admin</h1>
      {demo && <p>Demo mode — Supabase not configured. Showing placeholder data.</p>}

      <h2 className="mt-6 text-xl font-medium">Users</h2>
      <table className="w-full text-left">
        <thead>
          <tr>
            <th>Email</th>
            <th>Plan</th>
            <th>Suggestions (7d)</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.email}>
              <td>{u.email}</td>
              <td>{u.plan}</td>
              <td>{u.suggestions7d}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-6 text-xl font-medium">Adapter health</h2>
      {adapters.length === 0 ? (
        <p>No adapter data available.</p>
      ) : (
        <ul>
          {adapters.map((a) => (
            <li key={a.name}>
              {a.name}: {a.enabled ? 'enabled' : 'disabled'}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
