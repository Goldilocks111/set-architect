import { createAdminClient } from '@/lib/supabase/admin';
import type { SubscriptionRow } from '@/lib/supabase/types';

export type SubscriptionUpsert = {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string;
  plan: SubscriptionRow['plan'];
};

export type SubscriptionStore = {
  /** True only if the event was fully processed before. Recorded after success, never before. */
  hasProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
  upsertSubscription(row: SubscriptionUpsert): Promise<void>;
  updateStatusBySubscriptionId(subscriptionId: string, status: string): Promise<void>;
};

export function supabaseSubscriptionStore(): SubscriptionStore | null {
  const db = createAdminClient();
  if (!db) return null;
  return {
    async hasProcessed(eventId) {
      const { data, error } = await db
        .from('processed_stripe_events')
        .select('event_id')
        .eq('event_id', eventId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return !!data;
    },
    async markProcessed(eventId) {
      const { error } = await db.from('processed_stripe_events').insert({ event_id: eventId });
      if (error && error.code !== '23505') throw new Error(error.message);
    },
    async upsertSubscription(row) {
      const { error } = await db
        .from('subscriptions')
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throw new Error(error.message);
    },
    async updateStatusBySubscriptionId(subscriptionId, status) {
      const { error } = await db
        .from('subscriptions')
        .update({ status, plan: isPro(status) ? 'pro' : 'free', updated_at: new Date().toISOString() })
        .eq('stripe_subscription_id', subscriptionId);
      if (error) throw new Error(error.message);
    },
  };
}

export function isPro(status: string): boolean {
  return status === 'active' || status === 'trialing';
}
