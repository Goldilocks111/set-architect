# Supabase setup

The app runs in demo mode (no database, no login) until the Supabase env vars are set.

1. Create a project at https://supabase.com/dashboard and note its project ref.
2. Copy `.env.example` to `.env` and fill in `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (Project Settings -> API).
3. From the repo root:
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
   `db push` applies `supabase/migrations/0001_init.sql` (tables, RLS, profile-on-signup trigger).
4. Auth -> URL Configuration: set Site URL to `NEXT_PUBLIC_APP_URL` and add
   `<NEXT_PUBLIC_APP_URL>/auth/callback` to Redirect URLs (magic link sign-in).
5. Make yourself admin after first sign-in (SQL editor):
   ```sql
   update public.profiles set is_admin = true where email = 'you@example.com';
   ```

## Stripe

1. Create a Product with a recurring Price in the Stripe dashboard; put its id in `STRIPE_PRICE_PRO`.
2. Put the secret key in `STRIPE_SECRET_KEY`.
3. Add a webhook endpoint `<NEXT_PUBLIC_APP_URL>/api/stripe/webhook` listening for
   `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`;
   put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Enable the Customer Portal (Settings -> Billing -> Customer portal) for `/api/stripe/portal`.
