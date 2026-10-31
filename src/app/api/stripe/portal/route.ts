import { appUrl, billingNotConfigured, getStripe } from '@/lib/billing/stripe';
import { isDemoMode } from '@/lib/demo';
import { createClient } from '@/lib/supabase/server';


export async function POST() {
  const stripe = getStripe();
  if (isDemoMode() || !stripe) return billingNotConfigured();

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return Response.json({ error: 'unauthenticated' }, { status: 401 });

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', data.user.id)
    .maybeSingle();
  if (!sub?.stripe_customer_id) return Response.json({ error: 'no subscription' }, { status: 404 });

  const portal = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${appUrl()}/`,
  });
  return Response.json({ url: portal.url });
}
