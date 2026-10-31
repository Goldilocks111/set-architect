import { appUrl, billingNotConfigured, getStripe } from '@/lib/billing/stripe';
import { isDemoMode } from '@/lib/demo';
import { createClient } from '@/lib/supabase/server';


export async function POST() {
  const stripe = getStripe();
  const price = process.env.STRIPE_PRICE_PRO;
  if (isDemoMode() || !stripe || !price) return billingNotConfigured();

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return Response.json({ error: 'unauthenticated' }, { status: 401 });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: data.user.id,
    customer_email: data.user.email ?? undefined,
    success_url: `${appUrl()}/?upgraded=1`,
    cancel_url: `${appUrl()}/`,
  });
  return Response.json({ url: session.url });
}
