import type Stripe from 'stripe';
import { billingNotConfigured, getStripe } from '@/lib/billing/stripe';
import { supabaseSubscriptionStore } from '@/lib/billing/subscription-store';


export async function POST(request: Request) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const store = supabaseSubscriptionStore();
  if (!stripe || !secret || !store) return billingNotConfigured();

  const signature = request.headers.get('stripe-signature');
  if (!signature) return Response.json({ error: 'missing signature' }, { status: 400 });

  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch {
    return Response.json({ error: 'invalid signature' }, { status: 400 });
  }

  try {
    if (await store.hasProcessed(event.id)) {
      return Response.json({ received: true, duplicate: true });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id ?? session.metadata?.user_id;
      if (userId) {
        await store.upsertSubscription({
          user_id: userId,
          stripe_customer_id: typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null),
          stripe_subscription_id:
            typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null),
          status: 'active',
          plan: 'pro',
        });
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription;
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
      await store.updateStatusBySubscriptionId(sub.id, status);
    }
    // Recorded only after success: a crash before this line lets Stripe's retry re-run the (idempotent) handlers.
    await store.markProcessed(event.id);
  } catch {
    return Response.json({ error: 'processing failed' }, { status: 500 });
  }
  return Response.json({ received: true });
}
