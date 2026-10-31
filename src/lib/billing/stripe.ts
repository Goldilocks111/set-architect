import Stripe from 'stripe';

let cached: Stripe | null = null;

/** Lazily-built Stripe client; null when STRIPE_SECRET_KEY is missing. */
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  cached ??= new Stripe(key);
  return cached;
}

export function billingNotConfigured() {
  return Response.json({ error: 'billing not configured' }, { status: 503 });
}

export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}
