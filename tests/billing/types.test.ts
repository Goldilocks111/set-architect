import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, SubscriptionRow } from '@/lib/supabase/types';

// Compile-time check (run `npx tsc --noEmit`): queries typecheck against the hand-written row types.
async function queries(db: SupabaseClient<Database>) {
  const sub = await db.from('subscriptions').select('plan,status').eq('user_id', 'x').maybeSingle();
  const plan: SubscriptionRow['plan'] | undefined = sub.data?.plan;
  await db.from('usage_events').insert({ user_id: 'x', kind: 'suggestion' });
  await db.from('playlists').insert({ user_id: 'x', name: 'Warmup' });
  // @ts-expect-error wrong plan literal
  const bad: SubscriptionRow['plan'] = 'enterprise';
  return [plan, bad];
}

describe('supabase row types', () => {
  it('compiles', () => {
    expect(typeof queries).toBe('function');
  });
});
